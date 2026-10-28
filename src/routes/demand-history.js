const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db');
const { requireDate, requirePositiveId } = require('../validation');
const {
  closeOperationalHistoryThrough,
  runOperationalHistoryRebuild,
} = require('../demand-history');

function sendError(res, error) {
  res.status(error.status || 500).json({ success: false, message: error.message });
}

router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(req.query.page_size, 10) || 25));
    const fromDate = req.query.from_date ? requireDate(req.query.from_date, 'Từ ngày') : null;
    const toDate = req.query.to_date ? requireDate(req.query.to_date, 'Đến ngày') : null;
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).json({ success: false, message: 'Từ ngày không được lớn hơn đến ngày' });
    }
    const itemId = req.query.item_id ? requirePositiveId(req.query.item_id, 'Sản phẩm') : null;
    const warehouseId = req.query.warehouse_id ? requirePositiveId(req.query.warehouse_id, 'Kho') : null;
    const pool = await getPool();
    const result = await pool.request()
      .input('from_date', sql.Date, fromDate)
      .input('to_date', sql.Date, toDate)
      .input('item_id', sql.Int, itemId)
      .input('warehouse_id', sql.Int, warehouseId)
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('page_size', sql.Int, pageSize)
      .query(`
        SELECT h.id, h.demand_date, 
               h.opening_inventory, h.units_sold, h.received_quantity,
               h.adjustment_quantity, h.closing_inventory,
               h.item_id, h.warehouse_id,
               i.code AS item_code, i.name AS item_name,
               w.code AS warehouse_code, w.name AS warehouse_name,
               COUNT(*) OVER() AS total_count
        FROM dbo.daily_demand_history h
        LEFT JOIN dbo.items i ON i.id=h.item_id
        LEFT JOIN dbo.warehouses w ON w.id=h.warehouse_id
        WHERE (@from_date IS NULL OR h.demand_date>=@from_date)
          AND (@to_date IS NULL OR h.demand_date<=@to_date)
          AND (@item_id IS NULL OR h.item_id=@item_id)
          AND (@warehouse_id IS NULL OR h.warehouse_id=@warehouse_id)
        ORDER BY h.demand_date DESC, h.warehouse_id, h.item_id
        OFFSET @offset ROWS FETCH NEXT @page_size ROWS ONLY;
      `);
    const total = Number(result.recordset[0]?.total_count) || 0;
    const data = result.recordset.map(({ total_count, ...row }) => row);
    res.json({
      data,
      pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
      filters: { from_date: fromDate, to_date: toDate, item_id: itemId, warehouse_id: warehouseId },
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/close-day', async (req, res) => {
  try {
    const date = requireDate(req.body?.date, 'Ngày chốt');
    if (req.body?.confirm_complete !== true) {
      return res.status(400).json({ success: false, message: 'Cần xác nhận dữ liệu đã đầy đủ trước khi chốt lịch sử; ngày không phát sinh sẽ được ghi nhận là 0.' });
    }
    const pool = await getPool();
    const result = await closeOperationalHistoryThrough(pool, date, req.user.id);
    res.json({ success: true, data: result, message: `Đã chốt lịch sử nhu cầu đến ${date}` });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/rebuild', async (req, res) => {
  try {
    const fromDate = requireDate(req.body?.from_date, 'Từ ngày');
    const toDate = requireDate(req.body?.to_date, 'Đến ngày');
    if (req.body?.confirm_complete !== true) {
      return res.status(400).json({ success: false, message: 'Cần xác nhận dữ liệu đã đầy đủ trước khi tái tạo lịch sử.' });
    }
    const pool = await getPool();
    const result = await runOperationalHistoryRebuild(pool, fromDate, toDate, req.user.id);
    res.json({ success: true, data: result, message: `Đã tái tạo lịch sử từ ${fromDate} đến ${toDate}` });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
