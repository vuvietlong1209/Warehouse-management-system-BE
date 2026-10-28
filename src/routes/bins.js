const express = require('express');
const router = express.Router();
const { lockLedger, assertCatalogDocumentsSafe } = require('../document-reservations');
const { getPool, sql } = require('../db');
const { getBinStock } = require('../inventory');
const { runSerializable } = require('../transaction');
const { requirePositiveId } = require('../validation');

function requireLocationCode(value) {
  // Accept legacy numeric API callers without losing leading zeroes in text codes.
  const code = typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!code || code.length > 24 || /[\u0000-\u001f\u007f]/.test(code)) {
    const error = new Error('Mã vị trí phải là chuỗi từ 1 đến 24 ký tự, không chứa ký tự điều khiển');
    error.status = 400;
    throw error;
  }
  return code;
}

function requireMaxCapacity(value) {
  const capacity = Number(value);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    const error = new Error('Sức chứa tối đa phải là một số lớn hơn 0');
    error.status = 400;
    throw error;
  }
  return capacity;
}

// GET /api/bins
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const activityStatus = ['all', 'active', 'inactive'].includes(req.query.activity_status)
      ? req.query.activity_status
      : 'active';
    const result = await pool.request().input('activity_status', sql.NVarChar(10), activityStatus).query(`
      SELECT b.id, b.location_id, b.warehouse_id, b.description, b.max_capacity, b.status,
             b.created_at, b.updated_at, w.name AS warehouse_name
      FROM bins b
      LEFT JOIN warehouses w ON b.warehouse_id = w.id
      WHERE (@activity_status='all'
        OR (@activity_status='active' AND b.status=1)
        OR (@activity_status='inactive' AND b.status=0))
      ORDER BY b.id ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bins/:id
router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT b.*, w.name AS warehouse_name
        FROM bins b
        LEFT JOIN warehouses w ON b.warehouse_id = w.id
        WHERE b.id = @id
      `);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy vị trí kho' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bins
router.post('/', async (req, res) => {
  const { location_id, warehouse_id, description, max_capacity, status = true } = req.body;
  if (!location_id || !warehouse_id || max_capacity === undefined) {
    return res.status(400).json({ error: 'Thiếu mã vị trí, kho trực thuộc hoặc sức chứa tối đa' });
  }
  try {
    const locationCode = requireLocationCode(location_id);
    const maxCapacity = requireMaxCapacity(max_capacity);
    const pool = await getPool();
    const result = await pool.request()
      .input('location_id', sql.NVarChar(24), locationCode)
      .input('warehouse_id', sql.Int, warehouse_id)
      .input('description', sql.NVarChar(192), description || null)
      .input('max_capacity', sql.Numeric(18, 2), maxCapacity)
      .input('status', sql.Bit, status ? 1 : 0)
      .query(`
        INSERT INTO bins (location_id, warehouse_id, description, max_capacity, status)
        OUTPUT INSERTED.*
        VALUES (@location_id, @warehouse_id, @description, @max_capacity, @status)
      `);
    const bin = result.recordset[0];
    // Attach warehouse_name
    const wh = await pool.request()
      .input('wid', sql.Int, warehouse_id)
      .query('SELECT name FROM warehouses WHERE id = @wid');
    bin.warehouse_name = wh.recordset[0]?.name;
    res.status(201).json(bin);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/bins/:id
router.put('/:id', async (req, res) => {
  const { location_id, warehouse_id, description, max_capacity, status } = req.body;
  try {
    if (status !== undefined) return res.status(400).json({ error: 'Hãy thay đổi trạng thái qua chức năng quản lý trạng thái danh mục' });
    const binId = requirePositiveId(req.params.id, 'Vị trí kho');
    const locationCode = location_id === undefined ? undefined : requireLocationCode(location_id);
    const warehouseId = warehouse_id === undefined ? undefined : requirePositiveId(warehouse_id, 'Kho trực thuộc');
    const maxCapacity = max_capacity === undefined ? undefined : requireMaxCapacity(max_capacity);
    const result = await runSerializable(async transaction => {
      await lockLedger(transaction);
      const locked = await transaction.request().input('id', sql.Int, binId)
        .query('SELECT id, warehouse_id FROM bins WITH (UPDLOCK, HOLDLOCK) WHERE id=@id');
      if (!locked.recordset.length) return null;

      if (warehouseId !== undefined && warehouseId !== locked.recordset[0].warehouse_id) {
        await assertCatalogDocumentsSafe(transaction, "bin", binId);
        const references = await transaction.request().input('id', sql.Int, binId).query(`
          SELECT CASE WHEN EXISTS (SELECT 1 FROM goods_receipt_details WHERE bin_id=@id)
            OR EXISTS (SELECT 1 FROM goods_issue_details WHERE bin_id=@id)
            OR EXISTS (SELECT 1 FROM inventory_check_details WHERE bin_id=@id)
            THEN 1 ELSE 0 END AS used;
        `);
        if (references.recordset[0].used) {
          const error = new Error('Không thể đổi kho trực thuộc: vị trí đã phát sinh chứng từ nhập, xuất hoặc kiểm kê. Vui lòng tạo vị trí mới; không chuyển hàng bằng cách sửa danh mục.');
          error.status = 409;
          throw error;
        }
        const parent = await transaction.request().input('warehouse_id', sql.Int, warehouseId)
          .query('SELECT id FROM warehouses WITH (HOLDLOCK) WHERE id=@warehouse_id AND status=1');
        if (!parent.recordset.length) {
          const error = new Error('Kho trực thuộc không tồn tại hoặc đang ngừng hoạt động');
          error.status = 409;
          throw error;
        }
      }

      if (maxCapacity !== undefined) {
        const currentStock = await getBinStock(transaction, binId);
        if (maxCapacity < currentStock) {
          const error = new Error(`Không thể đặt sức chứa ${maxCapacity}: vị trí đang chứa ${currentStock} đơn vị`);
          error.status = 409;
          throw error;
        }
      }

      const updateRequest = transaction.request().input('id', sql.Int, binId);
      const setParts = [];
      if (locationCode !== undefined) { updateRequest.input('location_id', sql.NVarChar(24), locationCode); setParts.push('location_id = @location_id'); }
      if (warehouseId !== undefined) { updateRequest.input('warehouse_id', sql.Int, warehouseId); setParts.push('warehouse_id = @warehouse_id'); }
      if (description !== undefined) { updateRequest.input('description', sql.NVarChar(192), description); setParts.push('description = @description'); }
      if (maxCapacity !== undefined) { updateRequest.input('max_capacity', sql.Numeric(18, 2), maxCapacity); setParts.push('max_capacity = @max_capacity'); }
      if (setParts.length === 0) {
        const error = new Error('Không có trường nào cập nhật');
        error.status = 400;
        throw error;
      }
      setParts.push('updated_at = GETDATE()');
      return (await updateRequest.query(`UPDATE bins SET ${setParts.join(', ')} OUTPUT INSERTED.* WHERE id = @id`)).recordset[0];
    });
    if (!result) return res.status(404).json({ error: 'Không tìm thấy vị trí' });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/bins/:id
router.delete('/:id', async (req, res) => {
  try {
    const binId = requirePositiveId(req.params.id, 'Vị trí kho');
    const outcome = await runSerializable(async transaction => {
      await lockLedger(transaction);
      await assertCatalogDocumentsSafe(transaction, "bin", binId);
      const result = await transaction.request().input('id', sql.Int, binId).query(`
        SELECT b.description,
          (SELECT COUNT(*) FROM goods_receipt_details poi JOIN goods_receipts po ON po.id=poi.goods_receipt_id
           WHERE poi.bin_id=b.id AND po.status=1 AND (po.lifecycle_status='Draft' OR (po.lifecycle_status='Active' AND po.activated_at IS NULL)))
          + (SELECT COUNT(*) FROM goods_issue_details soi JOIN goods_issues so ON so.id=soi.goods_issue_id
             WHERE soi.bin_id=b.id AND so.status=1 AND (so.lifecycle_status='Draft' OR (so.lifecycle_status='Active' AND so.activated_at IS NULL)))
          + (SELECT COUNT(*) FROM inventory_check_details icd JOIN inventory_checks ic ON ic.id=icd.inventory_check_id
             WHERE icd.bin_id=b.id AND ic.status=1 AND ic.check_status='InProgress') pending_documents
        FROM bins b WITH (UPDLOCK, HOLDLOCK) WHERE b.id=@id AND b.status=1
      `);
      if (!result.recordset.length) return { status: 404, message: 'Không tìm thấy vị trí kho' };
      const bin = result.recordset[0];
      const binDescription = bin.description || `Vị trí #${binId}`;
      const stock = await getBinStock(transaction, binId);
      if (stock !== 0) {
        return { status: 409, message: `Không thể xóa vị trí "${binDescription}": Vị trí đang chứa ${stock} sản phẩm!` };
      }
      if (Number(bin.pending_documents) > 0) {
        return { status: 409, message: `Không thể xóa vị trí "${binDescription}": Vị trí đang nằm trong chứng từ chưa hoàn tất!` };
      }
      await transaction.request().input('id', sql.Int, binId)
        .query('UPDATE bins SET status=0, updated_at=GETDATE() WHERE id=@id');
      return { status: 200, message: 'Đã xóa vị trí kho thành công!' };
    });
    res.status(outcome.status).json({ success: outcome.status === 200, message: outcome.message });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
