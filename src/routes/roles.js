const express = require('express');
const router = express.Router();
const { getPool } = require('../db');

// GET /api/roles - Lấy tất cả vai trò
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT id, code, role_name, status, created_at, updated_at
      FROM roles
      ORDER BY id ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
