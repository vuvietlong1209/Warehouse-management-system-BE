const express = require('express');
const router = express.Router();
const { lockLedger, assertCatalogDocumentsSafe } = require('../document-reservations');
const { getPool, sql } = require('../db');

// GET /api/warehouses
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const activityStatus = ['all', 'active', 'inactive'].includes(req.query.activity_status)
      ? req.query.activity_status
      : 'active';
    const result = await pool.request().input('activity_status', sql.NVarChar(10), activityStatus).query(`
      SELECT * FROM warehouses
      WHERE (@activity_status='all'
        OR (@activity_status='active' AND status=1)
        OR (@activity_status='inactive' AND status=0))
      ORDER BY id ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/warehouses/:id
router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM warehouses WHERE id = @id');
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy kho hàng' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/warehouses
router.post('/', async (req, res) => {
  const { code, name, status = true } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Thiếu code hoặc name' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('code', sql.NVarChar(24), code)
      .input('name', sql.NVarChar(64), name)
      .input('status', sql.Bit, status ? 1 : 0)
      .query(`INSERT INTO warehouses (code, name, status) OUTPUT INSERTED.* VALUES (@code, @name, @status)`);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Mã kho đã tồn tại' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/warehouses/:id
router.put('/:id', async (req, res) => {
  const { code, name, status } = req.body;
  try {
    if (status !== undefined) return res.status(400).json({ error: 'Hãy thay đổi trạng thái qua chức năng quản lý trạng thái danh mục' });
    const pool = await getPool();
    const req2 = pool.request().input('id', sql.Int, req.params.id);
    let setParts = [];
    if (code !== undefined) { req2.input('code', sql.NVarChar(24), code); setParts.push('code = @code'); }
    if (name !== undefined) { req2.input('name', sql.NVarChar(64), name); setParts.push('name = @name'); }
    if (setParts.length === 0) return res.status(400).json({ error: 'Không có trường nào cập nhật' });
    setParts.push('updated_at = GETDATE()');
    const result = await req2.query(`UPDATE warehouses SET ${setParts.join(', ')} OUTPUT INSERTED.* WHERE id = @id`);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy kho' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/warehouses/:id
router.delete('/:id', async (req, res) => {
  let transaction;
  try {
    const pool = await getPool();
    const whId = parseInt(req.params.id);
    transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    await lockLedger(transaction);
    await assertCatalogDocumentsSafe(transaction, "warehouse", whId);

    // Lấy thông tin kho
    const whInfo = await transaction.request()
      .input('id', sql.Int, whId)
      .query('SELECT name, code FROM warehouses WITH (UPDLOCK, HOLDLOCK) WHERE id = @id AND status = 1');

    if (whInfo.recordset.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ success: false, message: 'Không tìm thấy kho hàng' });
    }

    const whName = whInfo.recordset[0].name;

    // Check tổng tồn kho của kho
    const stockResult = await transaction.request()
      .input('id', sql.Int, whId)
      .query(`
        SELECT
          ISNULL((SELECT SUM(poi.quantity_ordered) FROM receipt_transaction_details poi
                  JOIN receipt_transactions po ON poi.goods_receipt_id = po.id
                  WHERE po.warehouse_id = @id AND po.receipt_status = 'Confirmed' AND po.status = 1), 0)
          - ISNULL((SELECT SUM(soi.quantity_ordered) FROM issue_transaction_details soi
                    JOIN issue_transactions so ON soi.goods_issue_id = so.id
                    WHERE so.warehouse_id = @id AND so.issue_status = 'Confirmed' AND so.status = 1), 0)
          + ISNULL((SELECT SUM(icd.discrepancy) FROM inventory_check_details icd
                    JOIN inventory_checks ic ON icd.inventory_check_id = ic.id
                    WHERE ic.warehouse_id = @id AND ic.check_status = 'Completed'
                      AND ic.status = 1 AND icd.discrepancy_handled = 1), 0) AS stock
      `);
    const stock = Number(stockResult.recordset[0].stock) || 0;

    if (stock !== 0) {
      await transaction.rollback();
      return res.status(409).json({
        success: false,
        message: `Không thể xóa nhà kho "${whName}": Tồn kho hiện tại là ${stock} sản phẩm!`
      });
    }

    const pendingResult = await transaction.request().input('id', sql.Int, whId).query(`
      SELECT
        (SELECT COUNT(*) FROM receipt_transactions WHERE warehouse_id=@id AND status=1 AND receipt_status='Pending')
        + (SELECT COUNT(*) FROM issue_transactions WHERE warehouse_id=@id AND status=1 AND issue_status='Pending')
        + (SELECT COUNT(*) FROM inventory_checks WHERE warehouse_id=@id AND status=1 AND check_status='InProgress') pending_documents
    `);
    if (Number(pendingResult.recordset[0].pending_documents) > 0) {
      await transaction.rollback();
      transaction = null;
      return res.status(409).json({
        success: false,
        message: `Không thể xóa nhà kho "${whName}": Kho đang có chứng từ chưa hoàn tất!`,
      });
    }

    await transaction.request()
      .input('id', sql.Int, whId)
      .query(`
        UPDATE warehouses SET status = 0, updated_at = GETDATE() WHERE id = @id;
        UPDATE bins SET status = 0, updated_at = GETDATE() WHERE warehouse_id = @id;
      `);
    await transaction.commit();
    res.json({ success: true, message: 'Đã xóa nhà kho thành công!' });
  } catch (err) {
    if (transaction) {
      try { await transaction.rollback(); } catch (_) {}
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
