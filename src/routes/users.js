const express = require('express');
const router = express.Router();
const { lockLedger, assertCatalogDocumentsSafe } = require('../document-reservations');
const bcrypt = require('bcryptjs');
const { getPool, sql } = require('../db');
const { runSerializable } = require('../transaction');
const { requirePositiveId } = require('../validation');

// GET /api/users - Lấy tất cả người dùng
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const activityStatus = ['all', 'active', 'inactive'].includes(req.query.activity_status)
      ? req.query.activity_status
      : 'active';
    const result = await pool.request().input('activity_status', sql.NVarChar(10), activityStatus).query(`
      SELECT u.id, u.username, u.email, u.name, u.status, u.role_id,
             r.code AS role_code, r.role_name, u.created_at, u.updated_at
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE (@activity_status='all'
        OR (@activity_status='active' AND u.status=1)
        OR (@activity_status='inactive' AND u.status=0))
      ORDER BY u.id ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id
router.get('/:id', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT u.id, u.username, u.email, u.name, u.status, u.role_id,
               r.code AS role_code, r.role_name, u.created_at, u.updated_at
        FROM users u
        LEFT JOIN roles r ON u.role_id = r.id
        WHERE u.id = @id
      `);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users - Tạo người dùng mới
router.post('/', async (req, res) => {
  const { username, password, email, name, role_id, status = true } = req.body;
  if (!username || !password || !name || !role_id) {
    return res.status(400).json({ error: 'Thiếu thông tin bắt buộc: username, password, name, role_id' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 8 ký tự' });
  }
  try {
    const pool = await getPool();
    const hashedPwd = await bcrypt.hash(password, 10);

    const result = await pool.request()
      .input('username', sql.NVarChar(64), username)
      .input('password', sql.NVarChar(64), hashedPwd)
      .input('email', sql.NVarChar(64), email || null)
      .input('name', sql.NVarChar(64), name)
      .input('role_id', sql.Int, role_id)
      .input('status', sql.Bit, status ? 1 : 0)
      .query(`
        INSERT INTO users (username, password, email, name, role_id, status)
        OUTPUT INSERTED.id, INSERTED.username, INSERTED.email, INSERTED.name,
               INSERTED.role_id, INSERTED.status, INSERTED.created_at, INSERTED.updated_at
        VALUES (@username, @password, @email, @name, @role_id, @status)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    if (err.number === 2627) return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id - Cập nhật người dùng
router.put('/:id', async (req, res) => {
  const { username, password, email, name, role_id, status } = req.body;
  try {
    if (status !== undefined) return res.status(400).json({ error: 'Hãy thay đổi trạng thái qua chức năng quản lý trạng thái danh mục' });
    if (password && String(password).length < 8) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 8 ký tự' });
    }
    if (Number(req.params.id) === req.user.id && status === false) {
      return res.status(409).json({ error: 'Không thể tự vô hiệu hóa tài khoản đang đăng nhập' });
    }
    const pool = await getPool();
    if (Number(req.params.id) === req.user.id && role_id !== undefined) {
      const roleResult = await pool.request().input('role_id', sql.Int, role_id)
        .query('SELECT code FROM roles WHERE id=@role_id AND status=1');
      if (!roleResult.recordset.length || roleResult.recordset[0].code !== 'ADMIN') {
        return res.status(409).json({ error: 'Không thể tự hạ quyền tài khoản quản trị đang đăng nhập' });
      }
    }
    const request = pool.request().input('id', sql.Int, req.params.id);

    let setParts = [];
    if (username !== undefined) { request.input('username', sql.NVarChar(64), username); setParts.push('username = @username'); }
    if (password) { const h = await bcrypt.hash(password, 10); request.input('password', sql.NVarChar(64), h); setParts.push('password = @password'); }
    if (email !== undefined) { request.input('email', sql.NVarChar(64), email); setParts.push('email = @email'); }
    if (name !== undefined) { request.input('name', sql.NVarChar(64), name); setParts.push('name = @name'); }
    if (role_id !== undefined) { request.input('role_id', sql.Int, role_id); setParts.push('role_id = @role_id'); }

    if (setParts.length === 0) return res.status(400).json({ error: 'Không có trường nào để cập nhật' });
    setParts.push('updated_at = GETDATE()');

    const result = await request.query(`
      UPDATE users SET ${setParts.join(', ')}
      OUTPUT INSERTED.id, INSERTED.username, INSERTED.email, INSERTED.name,
             INSERTED.role_id, INSERTED.status, INSERTED.updated_at
      WHERE id = @id
    `);
    if (result.recordset.length === 0) return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
  try {
    const userId = requirePositiveId(req.params.id, 'Người dùng');
    if (userId === req.user.id) {
      return res.status(409).json({ success: false, message: 'Không thể tự xóa tài khoản đang đăng nhập' });
    }
    const outcome = await runSerializable(async transaction => {
      await lockLedger(transaction);
      await assertCatalogDocumentsSafe(transaction, "user", userId);
      const result = await transaction.request().input('id', sql.Int, userId).query(`
        SELECT u.name,
          (SELECT COUNT(*) FROM goods_receipts po
           WHERE po.user_id=u.id AND po.status=1 AND (po.lifecycle_status='Draft' OR (po.lifecycle_status='Active' AND po.activated_at IS NULL)))
          + (SELECT COUNT(*) FROM goods_issues so
             WHERE so.user_id=u.id AND so.status=1 AND (so.lifecycle_status='Draft' OR (so.lifecycle_status='Active' AND so.activated_at IS NULL)))
          + (SELECT COUNT(*) FROM inventory_checks ic
             WHERE ic.user_id=u.id AND ic.status=1 AND ic.check_status='InProgress') pending_documents
        FROM users u WITH (UPDLOCK, HOLDLOCK) WHERE u.id=@id AND u.status=1
      `);
      if (!result.recordset.length) return { status: 404, message: 'Không tìm thấy người dùng' };
      const user = result.recordset[0];
      if (Number(user.pending_documents) > 0) {
        return { status: 409, message: `Không thể xóa người dùng "${user.name}": Người dùng đang đứng tên chứng từ chưa hoàn tất!` };
      }
      await transaction.request().input('id', sql.Int, userId)
        .query('UPDATE users SET status=0, updated_at=GETDATE() WHERE id=@id');
      return { status: 200, message: 'Đã xóa người dùng thành công!' };
    });
    res.status(outcome.status).json({ success: outcome.status === 200, message: outcome.message });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
