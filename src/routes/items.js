const express = require('express');
const router = express.Router();
const { lockLedger, assertCatalogDocumentsSafe } = require('../document-reservations');
const { runSerializable } = require('../transaction');
const { getPool, sql } = require('../db');
const { requirePositiveId } = require('../validation');

// GET /api/items - Kèm tồn kho tính từ receipt_transactions và issue_transactions
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const usePagination = req.query.page !== undefined || req.query.search !== undefined || req.query.activity_status !== undefined;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(5, Number.parseInt(req.query.page_size, 10) || 25));
    const search = String(req.query.search || '').trim().slice(0, 128);
    const activityStatus = ['all', 'active', 'inactive'].includes(req.query.activity_status)
      ? req.query.activity_status
      : 'active';
    const request = pool.request()
      .input('search', sql.NVarChar(128), search)
      .input('activity_status', sql.NVarChar(10), activityStatus)
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('page_size', sql.Int, pageSize);
    const result = await request.query(`
      SELECT i.id, i.code, i.name, i.base_unit_id, i.status,
             i.created_at, i.updated_at,
             bu.code AS base_unit_name,
             (SELECT d.bin_id,SUM(d.reserved_quantity) quantity FROM goods_issue_details d JOIN goods_issues o ON o.id=d.goods_issue_id WHERE d.item_id=i.id AND o.lifecycle_status='Active' AND o.status=1 AND d.reserved_quantity>0 GROUP BY d.bin_id FOR JSON PATH) reserved_bins,
             ISNULL((
               SELECT SUM(poi.quantity_ordered)
               FROM receipt_transaction_details poi
               JOIN receipt_transactions po ON poi.goods_receipt_id = po.id
               WHERE poi.item_id = i.id AND po.receipt_status = 'Confirmed' AND po.status = 1
             ), 0)
             - ISNULL((
               SELECT SUM(soi.quantity_ordered)
               FROM issue_transaction_details soi
               JOIN issue_transactions so ON soi.goods_issue_id = so.id
               WHERE soi.item_id = i.id AND so.issue_status = 'Confirmed' AND so.status = 1
             ), 0)
             + ISNULL((
               SELECT SUM(icd.discrepancy)
               FROM inventory_check_details icd
               JOIN inventory_checks ic ON icd.inventory_check_id = ic.id
               WHERE icd.item_id = i.id AND ic.check_status = 'Completed'
                 AND ic.status = 1 AND icd.discrepancy_handled = 1
             ), 0) AS stock_quantity,
             COUNT(*) OVER() AS total_count
      FROM items i
      LEFT JOIN base_units bu ON i.base_unit_id = bu.id
      WHERE (@activity_status='all'
          OR (@activity_status='active' AND i.status=1)
          OR (@activity_status='inactive' AND i.status=0))
        AND (@search='' OR i.code LIKE '%' + @search + '%' OR i.name LIKE '%' + @search + '%')
      ORDER BY i.id ASC
      ${usePagination ? 'OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY' : ''}
    `);
    const total = Number(result.recordset[0]?.total_count) || 0;
    const data = result.recordset.map(({ total_count, ...item }) => item);
    if (!usePagination) return res.json(data);
    res.json({ data, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/items/:id
router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT i.*, bu.code AS base_unit_name
        FROM items i
        LEFT JOIN base_units bu ON i.base_unit_id = bu.id
        WHERE i.id = @id
      `);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/items/:id/history - Lịch sử xuất nhập của sản phẩm
router.get('/:id/history', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('item_id', sql.Int, req.params.id)
      .query(`
        SELECT 'Nhập' AS type, po.order_date AS date, po.code AS voucherCode,
               poi.quantity_ordered AS quantity, p.name AS partnerName, w.name AS warehouseName
        FROM receipt_transaction_details poi
        JOIN receipt_transactions po ON poi.goods_receipt_id = po.id
        JOIN partners p ON po.partner_id = p.id
        JOIN warehouses w ON po.warehouse_id = w.id
        WHERE poi.item_id = @item_id AND po.receipt_status = 'Confirmed' AND po.status = 1
        UNION ALL
        SELECT 'Xuất', so.order_date, so.code, soi.quantity_ordered, p.name, w.name
        FROM issue_transaction_details soi
        JOIN issue_transactions so ON soi.goods_issue_id = so.id
        JOIN partners p ON so.partner_id = p.id
        JOIN warehouses w ON so.warehouse_id = w.id
        WHERE soi.item_id = @item_id AND so.issue_status = 'Confirmed' AND so.status = 1
        UNION ALL
        SELECT 'Kiểm kê', ic.to_date, ic.code, icd.discrepancy, NULL, w.name
        FROM inventory_check_details icd
        JOIN inventory_checks ic ON icd.inventory_check_id = ic.id
        JOIN warehouses w ON ic.warehouse_id = w.id
        WHERE icd.item_id = @item_id AND ic.check_status = 'Completed'
          AND ic.status = 1 AND icd.discrepancy_handled = 1 AND icd.discrepancy <> 0
        ORDER BY date ASC
      `);

    let balance = 0;
    const history = result.recordset.map(row => {
      if (row.type === 'Nhập') balance += Number(row.quantity);
      else if (row.type === 'Xuất') balance -= Number(row.quantity);
      else balance += Number(row.quantity);
      return { ...row, balance };
    });
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/items
router.post('/', async (req, res) => {
  const { code, name, base_unit_id, status = true } = req.body;
  if (!code || !name || !base_unit_id) return res.status(400).json({ error: 'Thiếu code, name hoặc base_unit_id' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('code', sql.NVarChar(24), code)
      .input('name', sql.NVarChar(64), name)
      .input('base_unit_id', sql.Int, base_unit_id)
      .input('status', sql.Bit, status ? 1 : 0)
      .query(`
        INSERT INTO items (code, name, base_unit_id, status)
        OUTPUT INSERTED.*
        VALUES (@code, @name, @base_unit_id, @status)
      `);
    const item = result.recordset[0];
    // Attach unit name
    const unit = await pool.request()
      .input('uid', sql.Int, base_unit_id)
      .query('SELECT code FROM base_units WHERE id = @uid');
    item.base_unit_name = unit.recordset[0]?.code;
    item.stock_quantity = 0;
    res.status(201).json(item);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Mã sản phẩm đã tồn tại' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/items/import - Import nhiều sản phẩm từ Excel
router.post('/import', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0 || items.length > 1000) return res.status(400).json({ error: 'Mỗi lần nhập cần từ 1 đến 1.000 dòng sản phẩm' });
  try {
    const result = await runSerializable(async transaction => {
      await lockLedger(transaction);
      const inserted = [], errors = [];
      for (const [index, item] of items.entries()) {
        const code = String(item?.code || '').trim(), name = String(item?.name || '').trim();
        const base_unit_id = Number(item?.base_unit_id), status = item?.status ?? true;
        let message = !code || code.length > 24 ? 'Mã sản phẩm phải từ 1 đến 24 ký tự'
          : !name || name.length > 64 ? 'Tên sản phẩm phải từ 1 đến 64 ký tự'
          : !Number.isInteger(base_unit_id) || base_unit_id <= 0 ? 'Đơn vị tính không hợp lệ'
          : typeof status !== 'boolean' ? 'Trạng thái không hợp lệ' : '';
        if (!message) {
          const response = await transaction.request()
          .input('code', sql.NVarChar(24), code)
          .input('name', sql.NVarChar(64), name)
          .input('base_unit_id', sql.Int, base_unit_id)
          .input('status', sql.Bit, status ? 1 : 0)
          .query(`IF NOT EXISTS(SELECT 1 FROM base_units WHERE id=@base_unit_id AND status=1)
            SELECT N'Đơn vị tính không tồn tại hoặc đã ngừng hoạt động' AS import_error;
            ELSE IF EXISTS(SELECT 1 FROM items WHERE code=@code)
            SELECT N'Mã sản phẩm đã tồn tại' AS import_error;
            ELSE INSERT INTO items (code, name, base_unit_id, status) OUTPUT INSERTED.* VALUES (@code, @name, @base_unit_id, @status)`);
          message = response.recordset[0]?.import_error || '';
          if (!message) inserted.push(response.recordset[0]);
        }
        if (message) errors.push({ row: index + 2, code, message });
      }
      return { success: inserted.length > 0, total: items.length, inserted: inserted.length,
        failed: errors.length, errors, items: inserted,
        message: inserted.length ? `Đã nhập ${inserted.length}/${items.length} sản phẩm`
          : `Không nhập được sản phẩm nào. ${errors.map(e => `Dòng ${e.row}: ${e.message}`).slice(0, 5).join('; ')}` };
    });
    res.status(result.success ? 201 : 422).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/items/:id
router.put('/:id', async (req, res) => {
  const { code, name, base_unit_id, status } = req.body;
  try {
    if (status !== undefined) return res.status(400).json({ error: 'Hãy thay đổi trạng thái qua chức năng quản lý trạng thái danh mục' });
    if (code === undefined && name === undefined && base_unit_id === undefined) return res.status(400).json({ error: 'Không có trường nào cập nhật' });
    const id=requirePositiveId(req.params.id,'Sản phẩm');
    const result=await runSerializable(async transaction=>{
      await lockLedger(transaction);
      const old=(await transaction.request().input('id',sql.Int,id).query('SELECT base_unit_id FROM items WITH (UPDLOCK,HOLDLOCK) WHERE id=@id')).recordset[0];
      if(base_unit_id!==undefined && old && Number(base_unit_id)!==old.base_unit_id) await assertCatalogDocumentsSafe(transaction,'item',id);
      const req2=transaction.request().input('id',sql.Int,id),setParts=[];
      if(code!==undefined){req2.input('code',sql.NVarChar(24),code);setParts.push('code=@code');}
      if(name!==undefined){req2.input('name',sql.NVarChar(64),name);setParts.push('name=@name');}
      if(base_unit_id!==undefined){req2.input('base_unit_id',sql.Int,requirePositiveId(base_unit_id,'Đơn vị'));setParts.push('base_unit_id=@base_unit_id');}
      setParts.push('updated_at=GETDATE()');
      return req2.query(`UPDATE items SET ${setParts.join(',')} OUTPUT inserted.* WHERE id=@id`);
    });
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/items/:id - Kiểm tra tồn kho trước khi xóa
router.delete('/:id', async (req, res) => {
  let transaction;
  try {
    const pool = await getPool();
    const itemId = requirePositiveId(req.params.id, 'Sản phẩm');
    transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    await lockLedger(transaction);
    await assertCatalogDocumentsSafe(transaction, "item", itemId);

    const itemInfo = await transaction.request()
      .input('item_id', sql.Int, itemId)
      .query(`
        SELECT i.name, i.code, bu.code AS base_unit_name,
          ISNULL((SELECT SUM(poi.quantity_ordered) FROM receipt_transaction_details poi
                  JOIN receipt_transactions po ON poi.goods_receipt_id = po.id
                  WHERE poi.item_id = i.id AND po.receipt_status = 'Confirmed' AND po.status = 1), 0)
          - ISNULL((SELECT SUM(soi.quantity_ordered) FROM issue_transaction_details soi
                    JOIN issue_transactions so ON soi.goods_issue_id = so.id
                    WHERE soi.item_id = i.id AND so.issue_status = 'Confirmed' AND so.status = 1), 0)
          + ISNULL((SELECT SUM(icd.discrepancy) FROM inventory_check_details icd
                    JOIN inventory_checks ic ON icd.inventory_check_id = ic.id
                    WHERE icd.item_id = i.id AND ic.check_status = 'Completed'
                      AND ic.status = 1 AND icd.discrepancy_handled = 1), 0) AS stock,
          (SELECT COUNT(*) FROM receipt_transaction_details poi
           JOIN receipt_transactions po ON po.id=poi.goods_receipt_id
           WHERE poi.item_id=i.id AND po.status=1 AND po.receipt_status='Pending')
          + (SELECT COUNT(*) FROM issue_transaction_details soi
             JOIN issue_transactions so ON so.id=soi.goods_issue_id
             WHERE soi.item_id=i.id AND so.status=1 AND so.issue_status='Pending')
          + (SELECT COUNT(*) FROM inventory_check_details icd
             JOIN inventory_checks ic ON ic.id=icd.inventory_check_id
             WHERE icd.item_id=i.id AND ic.status=1 AND ic.check_status='InProgress') AS pending_documents
        FROM items i WITH (UPDLOCK, HOLDLOCK)
        LEFT JOIN base_units bu ON i.base_unit_id = bu.id
        WHERE i.id = @item_id AND i.status=1
      `);

    if (itemInfo.recordset.length === 0) {
      await transaction.rollback();
      transaction = null;
      return res.status(404).json({ success: false, message: 'Không tìm thấy sản phẩm' });
    }

    const item = itemInfo.recordset[0];
    const stock = Number(item.stock) || 0;

    if (stock !== 0) {
      await transaction.rollback();
      transaction = null;
      return res.status(409).json({
        success: false,
        message: `Không thể xóa sản phẩm "${item.name}": Mặt hàng hiện còn tồn kho (${stock} ${item.base_unit_name || 'sản phẩm'})!`
      });
    }

    if (Number(item.pending_documents) > 0) {
      await transaction.rollback();
      transaction = null;
      return res.status(409).json({
        success: false,
        message: `Không thể xóa sản phẩm "${item.name}": Sản phẩm đang nằm trong chứng từ chưa hoàn tất!`,
      });
    }

    await transaction.request()
      .input('id', sql.Int, itemId)
      .query('UPDATE items SET status = 0, updated_at = GETDATE() WHERE id = @id');
    await transaction.commit();
    transaction = null;
    res.json({ success: true, message: 'Đã xóa sản phẩm thành công!' });
  } catch (err) {
    if (transaction) {
      try { await transaction.rollback(); } catch (_) {}
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
