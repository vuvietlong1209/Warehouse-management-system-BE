const { valueItemStock, money } = require('./stock-valuation');

// Read the approved ledger once. Reporting never recalculates an issue's WAC.
function buildCostingReport(history, fromDate) {
  const rows = history.items.map(({ status, ...item }) => {
    const select = records => records.filter(row => row.item_id === item.id);
    const value = valueItemStock(item, select(history.receipts), select(history.issues), select(history.adjustments), fromDate);
    const profit = money(value.period_revenue - value.export_value);
    return { ...item, stock_quantity: value.ending_quantity, stock_value: value.ending_value,
      period_export_qty: value.export_quantity || 0, applied_unit_cost: value.export_quantity ? value.export_value / value.export_quantity : 0,
      weighted_avg_cost: value.average_cost, last_sale_price: value.last_sale_price,
      period_revenue: value.period_revenue, recorded_cogs: value.export_value || 0,
      gross_profit: profit, gross_margin_percent: value.period_revenue ? profit / value.period_revenue * 100 : 0 };
  });
  const summary = Object.fromEntries(['stock_quantity', 'stock_value', 'period_export_qty', 'period_revenue', 'recorded_cogs']
    .map(key => [key, money(rows.reduce((sum, row) => sum + row[key], 0))]));
  summary.gross_profit = money(summary.period_revenue - summary.recorded_cogs);
  summary.gross_margin_percent = summary.period_revenue ? summary.gross_profit / summary.period_revenue * 100 : 0;
  return { rows, summary };
}

module.exports = { buildCostingReport };
