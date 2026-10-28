const { sql } = require('./db');
const { valueItemStock } = require('./stock-valuation');
const { loadValuationData } = require('./valuation-data');

function requestFrom(executor) {
  return executor.request();
}

async function getItemBinStock(executor, itemId, binId, asOfDate = null) {
  const result = await requestFrom(executor)
    .input('item_id', sql.Int, itemId)
    .input('bin_id', sql.Int, binId)
    .input('as_of_date', sql.Date, asOfDate)
    .query(`
      SELECT
        ISNULL((
          SELECT SUM(poi.quantity_ordered)
          FROM receipt_transaction_details poi
          JOIN receipt_transactions po ON po.id = poi.goods_receipt_id
          WHERE poi.item_id = @item_id
            AND poi.bin_id = @bin_id
            AND po.receipt_status = 'Confirmed'
            AND po.status = 1
            AND (@as_of_date IS NULL OR po.order_date <= @as_of_date)
        ), 0)
        - ISNULL((
          SELECT SUM(soi.quantity_ordered)
          FROM issue_transaction_details soi
          JOIN issue_transactions so ON so.id = soi.goods_issue_id
          WHERE soi.item_id = @item_id
            AND soi.bin_id = @bin_id
            AND so.issue_status = 'Confirmed'
            AND so.status = 1
            AND (@as_of_date IS NULL OR so.order_date <= @as_of_date)
        ), 0)
        + ISNULL((
          SELECT SUM(icd.discrepancy)
          FROM inventory_check_details icd
          JOIN inventory_checks ic ON ic.id = icd.inventory_check_id
          WHERE icd.item_id = @item_id
            AND icd.bin_id = @bin_id
            AND ic.check_status = 'Completed'
            AND ic.status = 1
            AND icd.discrepancy_handled = 1
            AND (@as_of_date IS NULL OR ic.to_date <= @as_of_date)
        ), 0) AS stock
    `);
  return Number(result.recordset[0].stock) || 0;
}

async function getBinStock(executor, binId, asOfDate = null) {
  const result = await requestFrom(executor)
    .input('bin_id', sql.Int, binId)
    .input('as_of_date', sql.Date, asOfDate)
    .query(`
      SELECT
        ISNULL((
          SELECT SUM(poi.quantity_ordered)
          FROM receipt_transaction_details poi
          JOIN receipt_transactions po ON po.id = poi.goods_receipt_id
          WHERE poi.bin_id = @bin_id
            AND po.receipt_status = 'Confirmed'
            AND po.status = 1
            AND (@as_of_date IS NULL OR po.order_date <= @as_of_date)
        ), 0)
        - ISNULL((
          SELECT SUM(soi.quantity_ordered)
          FROM issue_transaction_details soi
          JOIN issue_transactions so ON so.id = soi.goods_issue_id
          WHERE soi.bin_id = @bin_id
            AND so.issue_status = 'Confirmed'
            AND so.status = 1
            AND (@as_of_date IS NULL OR so.order_date <= @as_of_date)
        ), 0)
        + ISNULL((
          SELECT SUM(icd.discrepancy)
          FROM inventory_check_details icd
          JOIN inventory_checks ic ON ic.id = icd.inventory_check_id
          WHERE icd.bin_id = @bin_id
            AND ic.check_status = 'Completed'
            AND ic.status = 1
            AND icd.discrepancy_handled = 1
            AND (@as_of_date IS NULL OR ic.to_date <= @as_of_date)
        ), 0) AS stock
    `);
  return Number(result.recordset[0].stock) || 0;
}

async function getWeightedAverageCost(executor, itemId, warehouseId = null, asOfDate = null) {
  const history = await loadValuationData(executor, { itemId, warehouseId, toDate: asOfDate });
  if (!history.items.length) return 0;
  return valueItemStock(history.items[0], history.receipts, history.issues, history.adjustments).average_cost;
}

async function getCountUnitCost(executor, itemId, warehouseId, asOfDate) {
  const history = await loadValuationData(executor, { itemId, warehouseId, toDate: asOfDate });
  if (!history.items.length) return 0;
  const valuation = valueItemStock(history.items[0], history.receipts, history.issues, history.adjustments);
  const state = valuation.warehouses.get(warehouseId);
  return state?.quantity > 0 ? state.value / state.quantity : state?.last_unit_cost || 0;
}

async function validateItemAndBin(executor, itemId, binId, warehouseId) {
  const result = await requestFrom(executor)
    .input('item_id', sql.Int, itemId)
    .input('bin_id', sql.Int, binId)
    .input('warehouse_id', sql.Int, warehouseId)
    .query(`
      SELECT
        CASE WHEN EXISTS (
          SELECT 1
          FROM items i
          JOIN base_units bu ON bu.id=i.base_unit_id
          WHERE i.id = @item_id AND i.status = 1 AND bu.status = 1
        ) THEN 1 ELSE 0 END AS item_valid,
        CASE WHEN EXISTS (
          SELECT 1
          FROM bins b
          JOIN warehouses w ON w.id=b.warehouse_id
          WHERE b.id = @bin_id AND b.warehouse_id = @warehouse_id
            AND b.status = 1 AND w.status = 1
        ) THEN 1 ELSE 0 END AS bin_valid
    `);
  return result.recordset[0];
}

async function validateDocumentHeader(executor, { warehouseId, partnerId = null, userId }) {
  const result = await requestFrom(executor)
    .input('warehouse_id', sql.Int, warehouseId)
    .input('partner_id', sql.Int, partnerId)
    .input('user_id', sql.Int, userId)
    .query(`
      SELECT
        CASE WHEN EXISTS (SELECT 1 FROM warehouses WHERE id=@warehouse_id AND status=1) THEN 1 ELSE 0 END warehouse_valid,
        CASE WHEN @partner_id IS NULL OR EXISTS (SELECT 1 FROM partners WHERE id=@partner_id AND status=1) THEN 1 ELSE 0 END partner_valid,
        CASE WHEN EXISTS (SELECT 1 FROM users WHERE id=@user_id AND status=1) THEN 1 ELSE 0 END user_valid
    `);
  return result.recordset[0];
}

module.exports = {
  getItemBinStock,
  getBinStock,
  getWeightedAverageCost,
  getCountUnitCost,
  validateItemAndBin,
  validateDocumentHeader,
};
