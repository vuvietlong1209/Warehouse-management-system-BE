const express = require('express');
const router = express.Router();
const { lockLedger, assertCatalogDocumentsSafe } = require('../document-reservations');
const { getPool, sql } = require('../db');
const { runSerializable } = require('../transaction');
const { requirePositiveId } = require('../validation');

// GET /api/base-units
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const activityStatus = ['all', 'active', 'inactive'].includes(req.query.activity_status)
      ? req.query.activity_status
      : 'active';
    const result = await pool.request().input('activity_status', sql.NVarChar(10), activityStatus).query(`
      SELECT * FROM base_units
      WHERE (@activity_status='all'
        OR (@activity_status='active' AND status=1)
        OR (@activity_status='inactive' AND status=0))
      ORDER BY id ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/base-units/:id
router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM base_units WHERE id = @id');
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy đơn vị tính' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/base-units
router.post('/', async (req, res) => {
  const { code, description, status = true } = req.body;
  if (!code) return res.status(400).json({ error: 'Thiếu code' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('code', sql.NVarChar(24), code)
      .input('description', sql.NVarChar(192), description || null)
      .input('status', sql.Bit, status ? 1 : 0)
      .query(`
        INSERT INTO base_units (code, description, status)
        OUTPUT INSERTED.*
        VALUES (@code, @description, @status)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Mã đơn vị đã tồn tại' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/base-units/:id
router.put('/:id', async (req, res) => {
  const { code, description, status } = req.body;
  try {
    if (status !== undefined) return res.status(400).json({ error: 'Hãy thay đổi trạng thái qua chức năng quản lý trạng thái danh mục' });
    const pool = await getPool();
    const req2 = pool.request().input('id', sql.Int, req.params.id);
    let setParts = [];
    if (code !== undefined) { req2.input('code', sql.NVarChar(24), code); setParts.push('code = @code'); }
    if (description !== undefined) { req2.input('description', sql.NVarChar(192), description); setParts.push('description = @description'); }
    if (setParts.length === 0) return res.status(400).json({ error: 'Không có trường nào cập nhật' });
    setParts.push('updated_at = GETDATE()');
    const result = await req2.query(`UPDATE base_units SET ${setParts.join(', ')} OUTPUT INSERTED.* WHERE id = @id`);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy đơn vị tính' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/base-units/:id
router.delete('/:id', async (req, res) => {
  try {
    const unitId = requirePositiveId(req.params.id, 'Đơn vị tính');
    const outcome = await runSerializable(async transaction => {
      await lockLedger(transaction);
      await assertCatalogDocumentsSafe(transaction, "unit", unitId);
      const result = await transaction.request().input('id', sql.Int, unitId).query(`
        SELECT bu.code, (SELECT COUNT(*) FROM items i WHERE i.base_unit_id=bu.id AND i.status=1) active_items
        FROM base_units bu WITH (UPDLOCK, HOLDLOCK) WHERE bu.id=@id AND bu.status=1
      `);
      if (!result.recordset.length) return { status: 404, message: 'Không tìm thấy đơn vị tính' };
      const unit = result.recordset[0];
      if (Number(unit.active_items) > 0) {
        return { status: 409, message: `Không thể xóa đơn vị tính "${unit.code}": Đơn vị tính đang được sản phẩm hoạt động sử dụng!` };
      }
      await transaction.request().input('id', sql.Int, unitId)
        .query('UPDATE base_units SET status=0, updated_at=GETDATE() WHERE id=@id');
      return { status: 200, message: 'Đã xóa đơn vị tính thành công!' };
    });
    res.status(outcome.status).json({ success: outcome.status === 200, message: outcome.message });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
