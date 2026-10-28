const { sql } = require('./db');

async function loadValuationData(executor, { toDate, warehouseId = null, itemId = null, search = '' }) {
  const result = await executor.request()
    .input('to_date', sql.Date, toDate || '9999-12-31')
    .input('warehouse_id', sql.Int, warehouseId)
    .input('item_id', sql.Int, itemId)
    .input('search', sql.NVarChar(128), search).query(`
      SELECT i.id,i.code,i.name,i.status,bu.code unit
      FROM items i LEFT JOIN base_units bu ON bu.id=i.base_unit_id
      WHERE (@item_id IS NULL OR i.id=@item_id)
        AND (@search='' OR i.code LIKE '%' + @search + '%' OR i.name LIKE '%' + @search + '%')
      ORDER BY i.code;
      SELECT d.item_id,d.bin_id,h.warehouse_id,d.quantity_ordered,d.unit_price,d.inventory_value,h.order_date,
        h.ledger_order_id order_id,d.ledger_line_id line_id,h.confirmed_at,h.code document_code
      FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id
      WHERE h.receipt_status='Confirmed' AND h.status=1 AND h.order_date<=@to_date
        AND (@warehouse_id IS NULL OR h.warehouse_id=@warehouse_id) AND (@item_id IS NULL OR d.item_id=@item_id);
      SELECT d.item_id,d.bin_id,h.warehouse_id,d.quantity_ordered,d.unit_price,d.cost_price,
        h.order_date,h.ledger_order_id order_id,d.ledger_line_id line_id,h.confirmed_at,h.code document_code
      FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id
      WHERE h.issue_status='Confirmed' AND h.status=1 AND h.order_date<=@to_date
        AND (@warehouse_id IS NULL OR h.warehouse_id=@warehouse_id) AND (@item_id IS NULL OR d.item_id=@item_id);
      SELECT d.item_id,d.bin_id,h.warehouse_id,d.discrepancy adjustment,h.to_date,
        h.id check_id,d.id detail_id,h.completed_at,h.code document_code,d.book_quantity,d.actual_quantity
      FROM inventory_check_details d JOIN inventory_checks h ON h.id=d.inventory_check_id
      WHERE h.check_status='Completed' AND h.status=1 AND d.discrepancy_handled=1 AND h.to_date<=@to_date
        AND (@warehouse_id IS NULL OR h.warehouse_id=@warehouse_id) AND (@item_id IS NULL OR d.item_id=@item_id);
    `);
  const [items, receipts, issues, adjustments] = result.recordsets;
  const historyIds = new Set([...receipts, ...issues, ...adjustments].map(row => row.item_id));
  return { items: items.filter(row => row.status || historyIds.has(row.id)), receipts, issues, adjustments };
}

module.exports = { loadValuationData };
