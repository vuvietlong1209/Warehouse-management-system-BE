const { sql } = require('./db');
const { todayKey } = require('./business-date');
const { httpError, requireDate } = require('./validation');

// Display-only receipt totals. Demand training continues to use issued quantities.
async function getWeeklyReceivedQuantities(pool, warehouseId, fromDate, toDate) {
  const result = await pool.request().input('warehouse_id', sql.Int, warehouseId)
    .input('from_date', sql.Date, fromDate).input('to_date', sql.Date, toDate).query(`
      SELECT d.item_id,h.warehouse_id,SUM(d.quantity_ordered) quantity
      FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id
      WHERE h.receipt_status='Confirmed' AND h.status=1 AND h.order_date BETWEEN @from_date AND @to_date
        AND (@warehouse_id IS NULL OR h.warehouse_id=@warehouse_id)
      GROUP BY d.item_id,h.warehouse_id;
    `);
  return new Map(result.recordset.map(row => [`${row.item_id}:${row.warehouse_id}`, Number(row.quantity) || 0]));
}

function recentPeriod(range, today = todayKey()) {
  if (!['week', 'two_weeks', 'month', 'two_months'].includes(range)) throw httpError(400, 'Chọn 1 tuần, 2 tuần, 1 tháng hoặc 2 tháng gần nhất');
  const end = new Date(`${today}T00:00:00Z`), start = new Date(end);
  if (range === 'week' || range === 'two_weeks') start.setUTCDate(start.getUTCDate() - (range === 'week' ? 6 : 13));
  else {
    const day = start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - (range === 'month' ? 1 : 2));
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay));
  }
  return { range, from_date: start.toISOString().slice(0, 10), to_date: today };
}

async function getRecentItemMovements(pool, itemId, warehouseId, range, asOfDate) {
  const cutoff = asOfDate ? requireDate(asOfDate, 'Ngày kết thúc') : todayKey();
  if (cutoff > todayKey()) throw httpError(400, 'Không thể xem lịch sử trong tương lai');
  const period = recentPeriod(range, cutoff);
  const result = await pool.request().input('item', sql.Int, itemId).input('warehouse', sql.Int, warehouseId)
    .input('from', sql.Date, period.from_date).input('to', sql.Date, period.to_date).query(`
      SELECT i.id,i.code,i.name,u.code unit FROM items i LEFT JOIN base_units u ON u.id=i.base_unit_id WHERE i.id=@item;
      WITH movements AS (
        SELECT h.id,'RECEIPT' kind,h.code,h.order_date,h.warehouse_id,d.bin_id,d.quantity_ordered quantity
        FROM receipt_transactions h JOIN receipt_transaction_details d ON d.goods_receipt_id=h.id
        WHERE d.item_id=@item AND h.status=1 AND h.receipt_status='Confirmed'
        UNION ALL
        SELECT h.id,'ISSUE',h.code,h.order_date,h.warehouse_id,d.bin_id,d.quantity_ordered
        FROM issue_transactions h JOIN issue_transaction_details d ON d.goods_issue_id=h.id
        WHERE d.item_id=@item AND h.status=1 AND h.issue_status='Confirmed'
      )
      SELECT m.*,w.name warehouse_name,b.location_id bin_code,b.description bin_description
      FROM movements m JOIN warehouses w ON w.id=m.warehouse_id LEFT JOIN bins b ON b.id=m.bin_id
      WHERE m.order_date BETWEEN @from AND @to AND (@warehouse IS NULL OR m.warehouse_id=@warehouse)
      ORDER BY m.order_date DESC,m.id DESC,m.bin_id;

      SELECT TOP 1 d.unit_price,h.order_date,h.code
      FROM receipt_transactions h JOIN receipt_transaction_details d ON d.goods_receipt_id=h.id
      WHERE d.item_id=@item AND h.status=1 AND h.receipt_status='Confirmed' AND h.order_date<=@to
        AND (@warehouse IS NULL OR h.warehouse_id=@warehouse)
      ORDER BY h.order_date DESC,h.id DESC,d.id DESC;
    `);
  if (!result.recordsets[0].length) throw httpError(404, 'Không tìm thấy vật tư');
  const data = result.recordsets[1].map(row => ({ ...row, quantity: Number(row.quantity) }));
  const latest = result.recordsets[2][0];
  return { item: result.recordsets[0][0], period, data,
    latest_receipt: latest ? { ...latest, unit_price: Number(latest.unit_price) } : null,
    summary: { received: data.filter(row => row.kind === 'RECEIPT').reduce((n, row) => n + row.quantity, 0),
      issued: data.filter(row => row.kind === 'ISSUE').reduce((n, row) => n + row.quantity, 0) } };
}

module.exports = { getWeeklyReceivedQuantities, getRecentItemMovements, recentPeriod };
