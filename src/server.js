require('dotenv').config();
const app = require('./app');
const { getPool } = require('./db');

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    // Kiểm tra kết nối DB ngay khi khởi động
    const pool = await getPool();

    const server = app.listen(PORT, () => {
      console.log('================================================');
      console.log(`🚀 E-Warehouse Backend đang chạy tại port ${PORT}`);
      console.log(`📡 API Base URL: http://localhost:${PORT}/api`);
      console.log(`❤️  Health check: http://localhost:${PORT}/health`);
      console.log('================================================');
      console.log('Endpoints:');
      console.log('  POST   /api/auth/login');
      console.log('  GET    /api/auth/me');
      console.log('  POST   /api/auth/logout');
      console.log('  GET    /api/roles');
      console.log('  GET|POST|PUT|DELETE /api/users');
      console.log('  GET|POST|PUT|DELETE /api/partners');
      console.log('  GET|POST|PUT|DELETE /api/base-units');
      console.log('  GET|POST|PUT|DELETE /api/warehouses');
      console.log('  GET|POST|PUT|DELETE /api/bins');
      console.log('  GET|POST|PUT|DELETE /api/items');
      console.log('  GET|POST /api/goods-receipts');
      console.log('  PATCH /api/goods-receipts/:id/confirm');
      console.log('  PATCH /api/goods-receipts/:id/reject');
      console.log('  GET|POST /api/goods-issues');
      console.log('  PATCH /api/goods-issues/:id/confirm');
      console.log('  PATCH /api/goods-issues/:id/reject');
      console.log('  GET|POST /api/inventory-checks');
      console.log('  GET    /api/dashboard');
      console.log('  GET    /api/reports/inventory-summary');
      console.log('  GET    /api/reports/costing');
      console.log('  GET    /api/demand-history');
      console.log('  POST   /api/demand-history/close-day');
      console.log('  POST   /api/demand-history/rebuild');
      console.log('  GET    /api/forecast');
      console.log('================================================');
    });

    server.once('error', async (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Không thể mở backend: cổng ${PORT} đang được một tiến trình khác sử dụng.`);
        console.error(`👉 Kiểm tra tiến trình bằng: netstat -ano | findstr :${PORT}`);
        console.error('👉 Nếu một cửa sổ backend khác đang chạy, hãy dùng cửa sổ đó hoặc dừng nó bằng Ctrl+C.');
      } else {
        console.error('❌ Lỗi máy chủ:', error.message);
      }
      try { await pool.close(); } catch (_) {}
      process.exitCode = 1;
    });

    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n🛑 Đang dừng backend (${signal})...`);
      server.close(async () => {
        try { await pool.close(); } catch (_) {}
        console.log('✅ Backend đã dừng và giải phóng cổng sạch sẽ.');
        process.exit(0);
      });
    };
    process.once('SIGINT', () => shutdown('Ctrl+C'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('❌ Không thể khởi động server:', err.message);
    console.error('👉 Hãy kiểm tra file backend/.env và cấu hình SQL Server!');
    process.exit(1);
  }
}

start();
