const { getPool } = require('../src/db');
const { checkSchema } = require('../src/schema-check');
(async () => {
  const pool = await getPool();
  try { await checkSchema(pool); console.log('Schema hợp lệ; không thay đổi dữ liệu.'); }
  finally { await pool.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
