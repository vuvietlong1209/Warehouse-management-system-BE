const { sqlDateKey } = require('./validation');

const EPSILON = 1e-8;
const numeric = value => Number(value) || 0;
const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
function valuationError(message) {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function valuationEvents(receipts, issues, adjustments) {
  // Effective date first; confirmation order resolves movements on the same day.
  // Without timestamps, a count is an end-of-day stock snapshot.
  const events = [
    ...receipts.map(row => ({ ...row, type: 'IN', priority: 0, date: sqlDateKey(row.order_date), stamp: row.confirmed_at })),
    ...issues.map(row => ({ ...row, type: 'OUT', priority: 1, date: sqlDateKey(row.order_date), stamp: row.confirmed_at })),
    ...adjustments.map(row => ({ ...row, type: 'ADJUSTMENT', priority: 2,
      date: sqlDateKey(row.to_date), stamp: row.completed_at, order_id: row.check_id, line_id: row.detail_id })),
  ];
  const fallbackDays = new Set(events.filter(row => !row.stamp).map(row => row.date));
  return events.sort((left, right) => left.date.localeCompare(right.date)
    || (!fallbackDays.has(left.date) ? new Date(left.stamp) - new Date(right.stamp) : 0)
    || left.priority - right.priority || numeric(left.order_id) - numeric(right.order_id)
    || numeric(left.line_id) - numeric(right.line_id));
}

// Approved cost_price is the accounting source; count adjustments use book WAC.
function valueItemStock(item, receipts, issues, adjustments, fromDate = '1900-01-01', options = {}) {
  const warehouses = new Map();
  const bins = new Map();
  const movements = [];
  let lastSalePrice = 0;
  let totalImportQuantity = 0;
  let totalImportValue = 0;
  for (const event of valuationEvents(receipts, issues, adjustments)) {
    if (!warehouses.has(event.warehouse_id)) warehouses.set(event.warehouse_id, { quantity: 0, value: 0, last_unit_cost: 0 });
    const state = warehouses.get(event.warehouse_id);
    const binKey = `${event.warehouse_id}:${event.bin_id}`;
    const binQuantity = bins.get(binKey) || 0;
    const label = `${item.code} tại vị trí ${event.bin_id}, ngày ${event.date}`;
    const currentAverage = state.quantity > EPSILON ? state.value / state.quantity : state.last_unit_cost;
    // Posting validation observes the same calculator as reports, including
    // zero-discrepancy counts (which are still committed stock snapshots).
    if (options.beforeMovement) {
      options.beforeMovement(event, { average_cost: currentAverage, bin_quantity: binQuantity });
    }
    let quantity;
    let value;
    let revenue = 0;
    if (event.type === 'IN') {
      quantity = numeric(event.quantity_ordered);
      value = event.inventory_value == null ? quantity * numeric(event.unit_price) : numeric(event.inventory_value);
      totalImportQuantity += quantity;
      totalImportValue += value;
    } else if (event.type === 'OUT') {
      const requested = numeric(event.quantity_ordered);
      const unitCost = numeric(event.cost_price);
      quantity = -requested;
      value = -money(requested * unitCost);
      revenue = requested * numeric(event.unit_price);
      if (event.date >= fromDate) lastSalePrice = numeric(event.unit_price);
    } else {
      quantity = numeric(event.adjustment);
      if (Math.abs(quantity) <= EPSILON) continue;
      if (!(state.quantity > EPSILON)) throw valuationError(`Không xác định được giá trị kiểm kê cho ${label}.`);
      value = quantity * currentAverage;
    }
    if (binQuantity + quantity < -EPSILON) throw valuationError(`Tồn kho âm khi định giá ${label}.`);
    bins.set(binKey, binQuantity + quantity);
    value = money(value);
    state.quantity += quantity;
    state.value += value;
    if (state.quantity < -EPSILON) throw valuationError(`Tồn kho âm khi định giá ${label}.`);
    if (state.quantity > EPSILON) state.last_unit_cost = state.value / state.quantity;
    movements.push({ type: event.type, date: event.date, quantity, value, revenue,
      order_id: event.order_id, line_id: event.line_id, warehouse_id: event.warehouse_id, bin_id: event.bin_id });
    // Persisted unit prices have two decimals. A full withdrawal may leave a
    // sub-cent-per-unit residue; expose it as value-only rounding, never stock.
    if (Math.abs(state.quantity) <= EPSILON && Math.abs(state.value) > EPSILON
      && Math.abs(state.value) <= Math.abs(quantity) * 0.005 + 0.01) {
      movements.push({ type: 'ROUNDING', date: event.date, quantity: 0, value: -state.value, revenue: 0,
        warehouse_id: event.warehouse_id, bin_id: event.bin_id });
      state.value = 0;
    }
  }
  const before = movements.filter(row => row.date < fromDate);
  const period = movements.filter(row => row.date >= fromDate);
  const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
  const imports = period.filter(row => row.type === 'IN');
  const exports = period.filter(row => row.type === 'OUT');
  const corrections = period.filter(row => row.type === 'ADJUSTMENT' || row.type === 'ROUNDING');
  const endingQuantity = [...warehouses.values()].reduce((total, row) => total + row.quantity, 0);
  const endingValue = [...warehouses.values()].reduce((total, row) => total + row.value, 0);
  return {
    beginning_quantity: sum(before, 'quantity'), beginning_value: money(sum(before, 'value')),
    import_quantity: sum(imports, 'quantity'), import_value: money(sum(imports, 'value')),
    export_quantity: -sum(exports, 'quantity'), export_value: money(-sum(exports, 'value')),
    adjustment_quantity: sum(corrections, 'quantity'), adjustment_value: money(sum(corrections, 'value')),
    rounding_value: money(sum(period.filter(row => row.type === 'ROUNDING'), 'value')),
    ending_quantity: endingQuantity, ending_value: money(endingValue),
    average_cost: endingQuantity > EPSILON ? endingValue / endingQuantity : 0,
    total_import_qty: totalImportQuantity, total_import_value: money(totalImportValue),
    period_revenue: money(sum(exports, 'revenue')), last_sale_price: lastSalePrice,
    warehouses, bins, movements,
  };
}

module.exports = { valueItemStock, valuationEvents, money };
