require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { requireAdmin } = require('./middleware/auth');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth',              require('./routes/auth'));
app.use('/api', requireAdmin);
app.use('/api/catalog-status',     require('./routes/catalog-status'));
app.use('/api/bootstrap',        require('./routes/bootstrap'));
app.use('/api/roles',             require('./routes/roles'));
app.use('/api/users',             require('./routes/users'));
app.use('/api/partners',          require('./routes/partners'));
app.use('/api/base-units',        require('./routes/units'));
app.use('/api/warehouses',        require('./routes/warehouses'));
app.use('/api/bins',              require('./routes/bins'));
app.use('/api/items',             require('./routes/items'));
app.use('/api/document-operations', require('./routes/document-operations').router);
app.use('/api/goods-receipts',   require('./routes/goods-receipts'));
app.use('/api/goods-issues',      require('./routes/goods-issues'));
app.use('/api/inventory-checks',  require('./routes/inventory-checks'));
app.use('/api/dashboard',         require('./routes/dashboard'));
app.use('/api/reports',           require('./routes/reports'));
app.use('/api/demand-history',     require('./routes/demand-history'));
app.use('/api/forecast',           require('./routes/forecast'));


// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.url} không tồn tại` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error', message: err.message });
});

module.exports = app;
