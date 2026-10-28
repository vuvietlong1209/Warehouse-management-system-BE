const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireDate } = require('../validation');
const { buildCostingReport } = require('../costing-report');
const { valueItemStock, money } = require('../stock-valuation');
const { loadValuationData } = require('../valuation-data');
const { renderReportFile } = require('../report-renderer');


// Render an authenticated user's report snapshot in memory only. No database writes.
router.post('/render', async (req, res) => {
  try {
    const file = await renderReportFile(req.body?.format, req.body?.snapshot);
    res.set('Content-Type', file.mime);
    res.set('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.set('Cache-Control', 'no-store');
    res.send(file.buffer);
  } catch (error) {
    errorResponse(res, error);
  }
});

function dateValue(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  return requireDate(value, label);
}

function optionalInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function pagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(query.page_size, 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function filters(query) {
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = dateValue(query.from_date, '1900-01-01', 'Từ ngày');
  const toDate = dateValue(query.to_date, today, 'Đến ngày');
  if (fromDate > toDate) {
    const error = new Error('Từ ngày không được lớn hơn đến ngày');
    error.status = 400;
    throw error;
  }
  return {
    fromDate,
    toDate,
    warehouseId: optionalInt(query.warehouse_id),
    itemId: optionalInt(query.item_id),
    search: String(query.search || '').trim().slice(0, 128),
  };
}

function errorResponse(res, error) {
  res.status(error.status || 500).json({ success: false, message: error.message });
}

function requireLedgerReport(query) {
  if (query.costing_method !== undefined) {
    const error = new Error('Báo cáo dùng giá vốn WAC đã duyệt, không nhận phương pháp tính thử');
    error.status = 400;
    throw error;
  }
}

function itemHistory(history, id) {
  return [history.receipts.filter(row => row.item_id === id),
    history.issues.filter(row => row.item_id === id), history.adjustments.filter(row => row.item_id === id)];
}

// Same valuation engine as approval; summaries are calculated BEFORE pagination.
router.get('/inventory-summary', async (req, res) => {
  try {
    const selected = filters(req.query);
    const paging = pagination(req.query);
    requireLedgerReport(req.query);
    const history = await loadValuationData(await getPool(), selected);
    const rows = history.items.map(({ status, ...item }) => {
      const value = valueItemStock(item, ...itemHistory(history, item.id), selected.fromDate);
      const { warehouses, bins, movements, total_import_qty, total_import_value,
        period_revenue, last_sale_price, ...fields } = value;
      return { ...item, ...fields };
    });
    const summaryKeys = ['beginning_quantity', 'beginning_value', 'import_quantity', 'import_value',
      'export_quantity', 'export_value', 'adjustment_quantity', 'adjustment_value', 'ending_quantity', 'ending_value'];
    const summary = Object.fromEntries(summaryKeys.map(key => [key, money(rows.reduce((total, row) => total + row[key], 0))]));
    res.json({ data: rows.slice(paging.offset, paging.offset + paging.pageSize), summary,
      pagination: { page: paging.page, page_size: paging.pageSize, total: rows.length, total_pages: Math.ceil(rows.length / paging.pageSize) },
      filters: selected });
  } catch (error) { errorResponse(res, error); }
});

// Read-only costing report from approved stock movements.
router.get('/costing', async (req, res) => {
  try {
    requireLedgerReport(req.query);
    const selected = filters(req.query);
    const paging = pagination(req.query);
    const history = await loadValuationData(await getPool(), selected);
    const { rows, summary } = buildCostingReport(history, selected.fromDate);
    res.json({ data: rows.slice(paging.offset, paging.offset + paging.pageSize), summary,
      pagination: { page: paging.page, page_size: paging.pageSize, total: rows.length, total_pages: Math.ceil(rows.length / paging.pageSize) },
      filters: selected });
  } catch (error) { errorResponse(res, error); }
});

module.exports = router;
