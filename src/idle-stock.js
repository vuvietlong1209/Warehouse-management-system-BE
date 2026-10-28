const { valueItemStock, money } = require('./stock-valuation');
const { loadValuationData } = require('./valuation-data');
const { todayKey } = require('./business-date');
const { requireDate, requirePositiveId, sqlDateKey, httpError } = require('./validation');

const IDLE_DAY_THRESHOLDS = [30, 60, 90, 180];
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLocaleLowerCase('vi');

function idleStockFilters(query = {}) {
  const minimumDays = Number(query.min_idle_days ?? 60);
  if (!IDLE_DAY_THRESHOLDS.includes(minimumDays)) throw httpError(400, 'Chọn số ngày không giao dịch: 30, 60, 90 hoặc 180');
  const page = Number(query.page ?? 1), pageSize = Number(query.page_size ?? 5);
  if (!Number.isInteger(page) || page < 1 || ![5, 10, 20, 25, 50, 100].includes(pageSize)) {
    throw httpError(400, 'Phân trang không hợp lệ');
  }
  const search = String(query.search || '').trim();
  if (search.length > 128) throw httpError(400, 'Từ khóa tìm kiếm không được dài quá 128 ký tự');
  return { minimumDays, page, pageSize, search,
    warehouseId: query.warehouse_id == null || query.warehouse_id === '' ? null : requirePositiveId(query.warehouse_id, 'Kho hàng') };
}

// A material can be idle at one warehouse while still moving at another.
// Values come directly from the existing ledger, never from the last receipt price.
function buildIdleStockRows(history, warehouses, { asOfDate, minimumDays = 60, warehouseId = null, search = '' }) {
  const cutoff = requireDate(asOfDate), day = Date.parse(`${cutoff}T00:00:00Z`);
  const names = new Map(warehouses.map(warehouse => [warehouse.id, warehouse.name]));
  const rows = [], terms = normalize(search).split(/\s+/).filter(Boolean);
  for (const item of history.items) {
    const select = (records, dateField) => records.filter(row => row.item_id === item.id
      && (!warehouseId || row.warehouse_id === warehouseId) && sqlDateKey(row[dateField]) <= cutoff);
    const valuation = valueItemStock(item, select(history.receipts, 'order_date'),
      select(history.issues, 'order_date'), select(history.adjustments, 'to_date'));
    const lastDates = new Map();
    for (const movement of valuation.movements) {
      if (movement.type === 'ROUNDING' || Math.abs(movement.quantity) <= 1e-8) continue;
      if (!lastDates.has(movement.warehouse_id) || lastDates.get(movement.warehouse_id) < movement.date) {
        lastDates.set(movement.warehouse_id, movement.date);
      }
    }
    for (const [warehouse, state] of valuation.warehouses) {
      if (state.quantity <= 1e-8) continue;
      const lastDate = lastDates.get(warehouse);
      if (!lastDate) continue;
      const idleDays = Math.round((day - Date.parse(`${lastDate}T00:00:00Z`)) / 86400000);
      if (idleDays < minimumDays) continue;
      const row = { item_id: item.id, item_code: item.code, item_name: item.name, unit: item.unit || '',
        warehouse_id: warehouse, warehouse_name: names.get(warehouse) || `Kho #${warehouse}`,
        stock_quantity: state.quantity, stock_value: money(state.value),
        last_movement_date: lastDate, idle_days: idleDays };
      const searchable = normalize(`${row.item_code} ${row.item_name} ${row.warehouse_name}`);
      if (terms.every(term => searchable.includes(term))) rows.push(row);
    }
  }
  return rows.sort((a, b) => b.stock_value - a.stock_value || b.idle_days - a.idle_days
    || a.item_code.localeCompare(b.item_code, 'vi', { numeric: true }) || a.warehouse_id - b.warehouse_id);
}

async function getIdleStock(executor, query = {}) {
  const filters = idleStockFilters(query), asOfDate = todayKey();
  const [history, locations] = await Promise.all([
    loadValuationData(executor, { toDate: asOfDate, warehouseId: filters.warehouseId }),
    executor.request().query('SELECT id,name FROM dbo.warehouses ORDER BY id'),
  ]);
  const rows = buildIdleStockRows(history, locations.recordset, { ...filters, asOfDate });
  const totalPages = Math.max(1, Math.ceil(rows.length / filters.pageSize));
  const page = Math.min(filters.page, totalPages), offset = (page - 1) * filters.pageSize;
  return { data: rows.slice(offset, offset + filters.pageSize), as_of_date: asOfDate,
    filters: { min_idle_days: filters.minimumDays, warehouse_id: filters.warehouseId, search: filters.search },
    pagination: { page, page_size: filters.pageSize, total: rows.length, total_pages: totalPages } };
}

module.exports = { IDLE_DAY_THRESHOLDS, idleStockFilters, buildIdleStockRows, getIdleStock };
