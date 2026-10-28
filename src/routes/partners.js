const express = require('express');
const router = express.Router();
const { lockLedger, assertCatalogDocumentsSafe } = require('../document-reservations');
const { getPool, sql } = require('../db');
const { runSerializable } = require('../transaction');
const { requirePositiveId } = require('../validation');

// GET /api/partners
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const activityStatus = ['all', 'active', 'inactive'].includes(req.query.activity_status)
      ? req.query.activity_status
      : 'active';
    const result = await pool.request().input('activity_status', sql.NVarChar(10), activityStatus).query(`
      SELECT id, code, name, phone_number, address, status, created_at, updated_at
      FROM partners
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

// GET /api/partners/:id
router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM partners WHERE id = @id');
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy đối tác' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/partners
router.post('/', async (req, res) => {
  const { code, name, phone_number, address, status = true } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Thiếu code hoặc name' });
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('code', sql.NVarChar(24), code)
      .input('name', sql.NVarChar(64), name)
      .input('phone_number', sql.NVarChar(10), phone_number || null)
      .input('address', sql.NVarChar(192), address || null)
      .input('status', sql.Bit, status ? 1 : 0)
      .query(`
        INSERT INTO partners (code, name, phone_number, address, status)
        OUTPUT INSERTED.*
        VALUES (@code, @name, @phone_number, @address, @status)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Mã đối tác đã tồn tại' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/partners/:id
router.put('/:id', async (req, res) => {
  const { code, name, phone_number, address, status } = req.body;
  try {
    if (status !== undefined) return res.status(400).json({ error: 'Hãy thay đổi trạng thái qua chức năng quản lý trạng thái danh mục' });
    const pool = await getPool();
    const req2 = pool.request().input('id', sql.Int, req.params.id);
    let setParts = [];
    if (code !== undefined) { req2.input('code', sql.NVarChar(24), code); setParts.push('code = @code'); }
    if (name !== undefined) { req2.input('name', sql.NVarChar(64), name); setParts.push('name = @name'); }
    if (phone_number !== undefined) { req2.input('phone_number', sql.NVarChar(10), phone_number); setParts.push('phone_number = @phone_number'); }
    if (address !== undefined) { req2.input('address', sql.NVarChar(192), address); setParts.push('address = @address'); }
    if (setParts.length === 0) return res.status(400).json({ error: 'Không có trường nào cập nhật' });
    setParts.push('updated_at = GETDATE()');
    const result = await req2.query(`UPDATE partners SET ${setParts.join(', ')} OUTPUT INSERTED.* WHERE id = @id`);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy đối tác' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/partners/:id (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const partnerId = requirePositiveId(req.params.id, 'Đối tác');
    const outcome = await runSerializable(async transaction => {
      await lockLedger(transaction);
      await assertCatalogDocumentsSafe(transaction, "partner", partnerId);
      const result = await transaction.request().input('id', sql.Int, partnerId).query(`
        SELECT p.name,
          (SELECT COUNT(*) FROM goods_receipts po
           WHERE po.partner_id=p.id AND po.status=1 AND (po.lifecycle_status='Draft' OR (po.lifecycle_status='Active' AND po.activated_at IS NULL)))
          + (SELECT COUNT(*) FROM goods_issues so
             WHERE so.partner_id=p.id AND so.status=1 AND (so.lifecycle_status='Draft' OR (so.lifecycle_status='Active' AND so.activated_at IS NULL))) pending_documents
        FROM partners p WITH (UPDLOCK, HOLDLOCK) WHERE p.id=@id AND p.status=1
      `);
      if (!result.recordset.length) return { status: 404, message: 'Không tìm thấy đối tác' };
      const partner = result.recordset[0];
      if (Number(partner.pending_documents) > 0) {
        return { status: 409, message: `Không thể xóa đối tác "${partner.name}": Đối tác đang có chứng từ chưa hoàn tất!` };
      }
      await transaction.request().input('id', sql.Int, partnerId)
        .query('UPDATE partners SET status=0, updated_at=GETDATE() WHERE id=@id');
      return { status: 200, message: 'Đã xóa đối tác thành công!' };
    });
    res.status(outcome.status).json({ success: outcome.status === 200, message: outcome.message });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
