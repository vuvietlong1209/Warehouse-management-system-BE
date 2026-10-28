require('dotenv').config();
const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER || 'localhost',
  port: parseInt(process.env.DB_PORT || '1433'),
  database: process.env.DB_NAME || 'EWarehouseDB',
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
    enableArithAbort: true,
  },
  pool: {
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
    acquireTimeoutMillis: 15000,
  },
};

// Windows Authentication hoặc SQL Authentication
if (process.env.DB_TRUSTED_CONNECTION === 'true') {
  config.options.trustedConnection = true;
} else {
  config.user = process.env.DB_USER || 'sa';
  config.password = process.env.DB_PASSWORD || '';
}


let pool = null;

async function getPool() {
  if (!pool || !pool.connected) {
    try {
      pool = await sql.connect(config);
      console.log('✅ Kết nối SQL Server thành công:', process.env.DB_SERVER, '/', process.env.DB_NAME);
    } catch (err) {
      console.error('❌ Lỗi kết nối SQL Server:', err.message);
      throw err;
    }
  }
  return pool;
}

module.exports = { getPool, sql };
