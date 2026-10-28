const express = require('express');
const router = express.Router();
const { reconcileReservations, rebalanceReservations } = require('../document-reservations');
const { getPool, sql } = require('../db');
const { getItemBinStock, getBinStock, getCountUnitCost, validateItemAndBin, validateDocumentHeader } = require('../inventory');
const { requireDate, requirePositiveId, sqlDateKey } = require('../validation');
const { syncOperationalHistoryAfterDocument } = require('../demand-history');
const { lockPostingWarehouse, captureStockPosting, validateStockPosting } = require('../stock-posting-guard');

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeDetails(details) {
  if (!Array.isArray(details) || details.length === 0) throw httpError(400, 'Phiếu kiểm kê phải có ít nhất một dòng sản phẩm');
  const seen = new Set();
  return details.map((detail, index) => {
    const normalized = {
      id: Number(detail.id) || null,
      check_detail_code: String(detail.check_detail_code || `KKCT-${index + 1}`).slice(0, 24),
      item_id: Number(detail.item_id),
      bin_id: Number(detail.bin_id),
      actual_quantity: Number(detail.actual_quantity),
    };
    if (!Number.isInteger(normalized.item_id) || !Number.isInteger(normalized.bin_id)) {
      throw httpError(400, `Dòng ${index + 1}: sản phẩm hoặc Bin không hợp lệ`);
    }
    if (!Number.isFinite(normalized.actual_quantity) || normalized.actual_quantity < 0) {
      throw httpError(400, `Dòng ${index + 1}: tồn thực tế không được âm`);
    }
    const key = `${normalized.item_id}_${normalized.bin_id}`;
    if (seen.has(key)) throw httpError(400, `Dòng ${index + 1}: sản phẩm và Bin đã bị trùng trong phiếu`);
    seen.add(key);
    return normalized;
  });
}

async function validateDetails(transaction, details, warehouseId) {
  for (const [index, detail] of details.entries()) {
    const valid = await validateItemAndBin(transaction, detail.item_id, detail.bin_id, warehouseId);
    if (!valid.item_valid) throw httpError(400, `Dòng ${index + 1}: sản phẩm không tồn tại hoặc đã ngừng hoạt động`);
    if (!valid.bin_valid) throw httpError(400, `Dòng ${index + 1}: Bin không thuộc kho kiểm kê hoặc đã ngừng hoạt động`);
  }
}

async function insertDetails(transaction, inventoryCheckId, details, asOfDate) {
  for (const detail of details) {
    const bookQuantity = await getItemBinStock(transaction, detail.item_id, detail.bin_id, asOfDate);
    const discrepancy = detail.actual_quantity - bookQuantity;
    await transaction.request()
      .input('ic_id', sql.Int, inventoryCheckId)
      .input('check_detail_code', sql.NVarChar(24), detail.check_detail_code)
      .input('item_id', sql.Int, detail.item_id)
      .input('bin_id', sql.Int, detail.bin_id)
      .input('actual_quantity', sql.Numeric(18, 2), detail.actual_quantity)
      .input('book_quantity', sql.Numeric(18, 2), bookQuantity)
      .input('discrepancy', sql.Numeric(18, 2), discrepancy)
      .query(`
        INSERT INTO inventory_check_details
          (inventory_check_id, check_detail_code, item_id, bin_id, actual_quantity, book_quantity, discrepancy, discrepancy_handled)
        VALUES
          (@ic_id, @check_detail_code, @item_id, @bin_id, @actual_quantity, @book_quantity, @discrepancy, 0)
      `);
  }
}

async function runTransaction(work) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await work(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

function sendError(res, error) {
  if (error.number === 2601 || error.number === 2627) {
    return res.status(409).json({ success: false, message: 'Mã kiểm kê đã tồn tại' });
  }
  return res.status(error.status || 500).json({ success: false, message: error.message, code: error.code, impact: error.impact });
}

router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const usePagination = req.query.page !== undefined || req.query.search !== undefined || req.query.status !== undefined;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(req.query.page_size, 10) || 25));
    const search = String(req.query.search || '').trim().slice(0, 128);
    const documentStatus = ['InProgress','Completed','Cancelled'].includes(req.query.status) ? req.query.status : '';
    const checksResult = await pool.request()
      .input('search', sql.NVarChar(128), search)
      .input('document_status', sql.NVarChar(20), documentStatus)
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('page_size', sql.Int, pageSize).query(`
      SELECT ic.id, ic.code, ic.from_date, ic.to_date, ic.warehouse_id, ic.user_id,
             ic.description, ic.check_status, ic.status, ic.created_at, ic.updated_at,
             ic.completed_at, ic.cancelled_at,
             w.name AS warehouse_name, u.name AS user_name, COUNT(*) OVER() total_count
      FROM inventory_checks ic
      LEFT JOIN warehouses w ON ic.warehouse_id=w.id
      LEFT JOIN users u ON ic.user_id=u.id
      WHERE ic.status=1 AND (@document_status='' OR ic.check_status=@document_status)
        AND (@search='' OR ic.code LIKE '%' + @search + '%' OR u.name LIKE '%' + @search + '%')
      ORDER BY ic.id DESC
      ${usePagination ? 'OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY' : ''}
    `);
    const checks = checksResult.recordset;
    if (!checks.length) return res.json(usePagination ? { data: [], pagination: { page, page_size: pageSize, total: 0, total_pages: 0 } } : []);
    const total = Number(checks[0].total_count) || 0;
    const ids = checks.map(check => check.id).join(',');
    const detailsResult = await pool.request().query(`
      SELECT icd.*, i.code AS item_code, i.name AS item_name, b.description AS bin_description
      FROM inventory_check_details icd
      LEFT JOIN items i ON icd.item_id=i.id
      LEFT JOIN bins b ON icd.bin_id=b.id
      WHERE icd.inventory_check_id IN (${ids}) ORDER BY icd.id ASC
    `);
    const map = {};
    detailsResult.recordset.forEach(detail => (map[detail.inventory_check_id] ||= []).push(detail));
    const data = checks.map(({ total_count, ...check }) => ({ ...check, details: map[check.id] || [] }));
    res.json(usePagination ? { data, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } } : data);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const checkResult = await pool.request().input('id', sql.Int, req.params.id).query(`
      SELECT ic.*, w.name AS warehouse_name, u.name AS user_name
      FROM inventory_checks ic
      LEFT JOIN warehouses w ON ic.warehouse_id=w.id
      LEFT JOIN users u ON ic.user_id=u.id
      WHERE ic.id=@id AND ic.status=1
    `);
    if (!checkResult.recordset.length) throw httpError(404, 'Không tìm thấy phiếu kiểm kê');
    const check = checkResult.recordset[0];
    check.details = (await pool.request().input('id', sql.Int, check.id).query(`
      SELECT icd.*, i.code AS item_code, i.name AS item_name, b.description AS bin_description
      FROM inventory_check_details icd
      LEFT JOIN items i ON icd.item_id=i.id
      LEFT JOIN bins b ON icd.bin_id=b.id
      WHERE icd.inventory_check_id=@id ORDER BY icd.id ASC
    `)).recordset;
    res.json(check);
  } catch (error) {
    sendError(res, error);
  }
});

// POST /api/inventory-checks - luôn tạo InProgress, book quantity do server tính
router.post('/', async (req, res) => {
  try {
    const { code, from_date, to_date, warehouse_id, description, details } = req.body;
    if (!code || !from_date || !to_date || !warehouse_id) throw httpError(400, 'Thiếu thông tin bắt buộc');
    const fromDate = requireDate(from_date, 'Từ ngày');
    const toDate = requireDate(to_date, 'Đến ngày');
    if (fromDate > toDate) throw httpError(400, 'Từ ngày không được lớn hơn đến ngày');
    const warehouseId = requirePositiveId(warehouse_id, 'Kho');
    const userId = requirePositiveId(req.user.id, 'Người lập phiếu');
    if (req.body.check_status && req.body.check_status !== 'InProgress') {
      throw httpError(400, 'Phiếu mới phải ở trạng thái InProgress và được hoàn tất bằng endpoint complete');
    }
    const lines = normalizeDetails(details);
    const icId = await runTransaction(async transaction => {
      await validateDetails(transaction, lines, warehouseId);
      const result = await transaction.request()
        .input('code', sql.NVarChar(24), code)
        .input('from_date', sql.Date, fromDate)
        .input('to_date', sql.Date, toDate)
        .input('warehouse_id', sql.Int, warehouseId)
        .input('user_id', sql.Int, userId)
        .input('description', sql.NVarChar(192), description || null)
        .query(`
          INSERT INTO inventory_checks (code, from_date, to_date, warehouse_id, user_id, description, check_status)
          OUTPUT INSERTED.id
          VALUES (@code, @from_date, @to_date, @warehouse_id, @user_id, @description, 'InProgress')
        `);
      const id = result.recordset[0].id;
      await insertDetails(transaction, id, lines, toDate);
      return id;
    });
    res.status(201).json({ success: true, icId, message: 'Đã tạo phiếu kiểm kê đang thực hiện' });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { code, from_date, to_date, warehouse_id, description, details } = req.body;
    if (!code || !from_date || !to_date || !warehouse_id) throw httpError(400, 'Thiếu thông tin bắt buộc');
    const fromDate = requireDate(from_date, 'Từ ngày');
    const toDate = requireDate(to_date, 'Đến ngày');
    if (fromDate > toDate) throw httpError(400, 'Từ ngày không được lớn hơn đến ngày');
    const warehouseId = requirePositiveId(warehouse_id, 'Kho');
    const lines = normalizeDetails(details);
    await runTransaction(async transaction => {
      const locked = await transaction.request().input('id', sql.Int, req.params.id)
        .query(`SELECT check_status FROM inventory_checks WITH (UPDLOCK, HOLDLOCK) WHERE id=@id AND status=1`);
      if (!locked.recordset.length) throw httpError(404, 'Không tìm thấy phiếu kiểm kê');
      if (locked.recordset[0].check_status !== 'InProgress') throw httpError(409, 'Chỉ được sửa phiếu kiểm kê đang thực hiện');
      await validateDetails(transaction, lines, warehouseId);
      await transaction.request()
        .input('id', sql.Int, req.params.id)
        .input('code', sql.NVarChar(24), code)
        .input('from_date', sql.Date, fromDate)
        .input('to_date', sql.Date, toDate)
        .input('warehouse_id', sql.Int, warehouseId)
        .input('description', sql.NVarChar(192), description || null)
        .query(`UPDATE inventory_checks SET code=@code, from_date=@from_date, to_date=@to_date,
          warehouse_id=@warehouse_id, description=@description, updated_at=GETDATE() WHERE id=@id`);
      await transaction.request().input('id', sql.Int, req.params.id)
        .query('DELETE FROM inventory_check_details WHERE inventory_check_id=@id');
      await insertDetails(transaction, Number(req.params.id), lines, toDate);
    });
    res.json({ success: true, message: 'Đã cập nhật phiếu kiểm kê' });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await runTransaction(async transaction => {
      const locked = await transaction.request().input('id', sql.Int, req.params.id)
        .query(`SELECT check_status FROM inventory_checks WITH (UPDLOCK, HOLDLOCK) WHERE id=@id AND status=1`);
      if (!locked.recordset.length) throw httpError(404, 'Không tìm thấy phiếu kiểm kê');
      if (locked.recordset[0].check_status !== 'InProgress') throw httpError(409, 'Chỉ được xóa phiếu kiểm kê đang thực hiện');
      await transaction.request().input('id', sql.Int, req.params.id)
        .query('DELETE FROM inventory_check_details WHERE inventory_check_id=@id; DELETE FROM inventory_checks WHERE id=@id;');
    });
    res.json({ success: true, message: 'Đã xóa phiếu kiểm kê đang thực hiện' });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/:id/complete', async (req, res) => {
  try {
    await runTransaction(async transaction => {
      const warehouseId = await lockPostingWarehouse(transaction, 'inventory_checks', req.params.id);
      const locked = await transaction.request().input('id', sql.Int, req.params.id)
        .query(`SELECT check_status, warehouse_id, user_id, to_date FROM inventory_checks WITH (UPDLOCK, HOLDLOCK) WHERE id=@id AND status=1`);
      if (!locked.recordset.length) throw httpError(404, 'Không tìm thấy phiếu kiểm kê');
      if (locked.recordset[0].warehouse_id !== warehouseId) throw httpError(409, 'Kho của phiếu vừa thay đổi, vui lòng tải lại');
      if (locked.recordset[0].check_status !== 'InProgress') throw httpError(409, 'Phiếu kiểm kê không còn ở trạng thái đang thực hiện');
      const header = await validateDocumentHeader(transaction, {
        warehouseId: locked.recordset[0].warehouse_id,
        userId: locked.recordset[0].user_id,
      });
      if (!header.warehouse_valid) throw httpError(409, 'Không thể hoàn tất: kho hàng đã ngừng hoạt động');
      if (!header.user_valid) throw httpError(409, 'Không thể hoàn tất: người lập phiếu đã ngừng hoạt động');
      const details = normalizeDetails((await transaction.request().input('id', sql.Int, req.params.id)
        .query('SELECT * FROM inventory_check_details WHERE inventory_check_id=@id ORDER BY id ASC')).recordset);
      await validateDetails(transaction, details, locked.recordset[0].warehouse_id);
      const snapshot = await captureStockPosting(transaction, warehouseId, details);

      const adjustmentByBin = new Map();
      for (const detail of details) {
        const bookQuantity = await getItemBinStock(transaction, detail.item_id, detail.bin_id, locked.recordset[0].to_date);
        const discrepancy = detail.actual_quantity - bookQuantity;
        if (discrepancy !== 0 && bookQuantity <= 0 && !(await getCountUnitCost(transaction, detail.item_id,
          locked.recordset[0].warehouse_id, locked.recordset[0].to_date) > 0)) {
          throw httpError(409, `Không xác định được đơn giá tồn để định giá kiểm kê sản phẩm id=${detail.item_id}`);
        }
        adjustmentByBin.set(detail.bin_id, (adjustmentByBin.get(detail.bin_id) || 0) + discrepancy);
        await transaction.request()
          .input('detail_id', sql.Int, detail.id)
          .input('book_quantity', sql.Numeric(18, 2), bookQuantity)
          .input('discrepancy', sql.Numeric(18, 2), discrepancy)
          .query(`UPDATE inventory_check_details SET book_quantity=@book_quantity, discrepancy=@discrepancy,
            discrepancy_handled=1, updated_at=GETDATE() WHERE id=@detail_id`);
      }

      for (const [binId, adjustment] of adjustmentByBin) {
        const binResult = await transaction.request().input('bin_id', sql.Int, binId).query(`
          SELECT location_id, max_capacity
          FROM bins WITH (UPDLOCK, HOLDLOCK)
          WHERE id=@bin_id AND status=1
        `);
        if (!binResult.recordset.length) throw httpError(400, `Không tìm thấy vị trí bin_id=${binId}`);
        const current = await getBinStock(transaction, binId);
        const maxCapacity = Number(binResult.recordset[0].max_capacity);
        if (current + adjustment > maxCapacity) {
          throw httpError(409, `Không thể hoàn tất: tồn thực tế tại BIN-${binResult.recordset[0].location_id} vượt sức chứa ${maxCapacity}`);
        }
      }

      await transaction.request().input('id', sql.Int, req.params.id)
        .query(`UPDATE inventory_checks SET check_status='Completed', completed_at=GETDATE(),
          cancelled_at=NULL, updated_at=GETDATE() WHERE id=@id`);
      await validateStockPosting(transaction, snapshot);
      await reconcileReservations(transaction, details, req.body.release_reservations === true, req.user.id);
      await rebalanceReservations(transaction);
      await syncOperationalHistoryAfterDocument(transaction, {
        date: sqlDateKey(locked.recordset[0].to_date),
        warehouseId: locked.recordset[0].warehouse_id,
        itemIds: details.map(detail => detail.item_id),
        createdBy: req.user.id,
      });
    });
    res.json({ success: true, message: 'Đã hoàn tất kiểm kê và ghi nhận chênh lệch vào tồn kho' });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch('/:id/cancel', async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) throw httpError(400, 'Vui lòng nhập lý do hủy');
    await runTransaction(async transaction => {
      const locked = await transaction.request().input('id', sql.Int, req.params.id)
        .query(`SELECT check_status FROM inventory_checks WITH (UPDLOCK, HOLDLOCK) WHERE id=@id AND status=1`);
      if (!locked.recordset.length) throw httpError(404, 'Không tìm thấy phiếu kiểm kê');
      if (locked.recordset[0].check_status !== 'InProgress') throw httpError(409, 'Phiếu kiểm kê không còn ở trạng thái đang thực hiện');
      await transaction.request().input('id', sql.Int, req.params.id).input('reason', sql.NVarChar(120), reason).query(`
        UPDATE inventory_checks SET check_status='Cancelled', cancelled_at=GETDATE(),
          completed_at=NULL, updated_at=GETDATE(),
          description=LEFT(CONCAT(ISNULL(description, ''), CASE WHEN description IS NULL OR description='' THEN '' ELSE ' | ' END,
          N'Lý do hủy: ', @reason), 192) WHERE id=@id
      `);
    });
    res.json({ success: true, message: 'Đã hủy phiếu kiểm kê' });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
