const { sql } = require('./db');
const { demandSeriesCtes } = require('./demand-series');

function optionalDate(value) {
  return value || null;
}

function optionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} phải là số nguyên dương`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

async function getWeeklyDemandSeries(executor, options = {}) {
  const itemId = optionalPositiveInteger(options.itemId, 'Sản phẩm');
  const warehouseId = optionalPositiveInteger(options.warehouseId, 'Kho');
  const completeOnly = options.completeOnly !== false;
  const activeOnly = options.activeOnly === true;
  const result = await executor.request()
    .input('from_date', sql.Date, optionalDate(options.fromDate))
    .input('to_date', sql.Date, optionalDate(options.toDate))
    .input('item_id', sql.Int, itemId)
    .input('warehouse_id', sql.Int, warehouseId)
    .query(`
      WITH ${demandSeriesCtes("COALESCE(@to_date,CONVERT(date,'99991231',112))")}
      SELECT h.week_start, h.week_end, h.item_id, h.warehouse_id,
             i.code AS item_code, i.name AS item_name,
             w.code AS warehouse_code, w.name AS warehouse_name,
             i.status AS item_active, bu.status AS unit_active, w.status AS warehouse_active,
             h.opening_inventory, h.units_sold, h.received_quantity, h.adjustment_quantity,
             h.closing_inventory, h.calendar_day_count,
             h.zero_demand_day_count, h.stockout_day_count,
             h.is_complete_week, h.is_training_eligible
      FROM dbo.weekly_demand_history h
      INNER JOIN tracked_pairs p ON p.item_id=h.item_id AND p.warehouse_id=h.warehouse_id
      LEFT JOIN dbo.items i ON i.id = h.item_id
      LEFT JOIN dbo.base_units bu ON bu.id = i.base_unit_id
      LEFT JOIN dbo.warehouses w ON w.id = h.warehouse_id
      WHERE (@from_date IS NULL OR h.week_start >= @from_date)
        AND (@to_date IS NULL OR h.week_end <= @to_date)
        AND (@item_id IS NULL OR h.item_id = @item_id)
        AND (@warehouse_id IS NULL OR h.warehouse_id = @warehouse_id)
      ORDER BY h.warehouse_id, h.item_id, h.week_start
      OPTION (RECOMPILE, MAXDOP 1, MAX_GRANT_PERCENT=5);
    `);
  // Filter derived eligibility/current catalog flags after the window aggregate.
  // This avoids SQL pushing selective predicates into that aggregate and keeps
  // the exact persisted eligibility/catalog rules without inferring any demand.
  const enabled = value => value === true || value === 1;
  return result.recordset
    .filter(row => (!completeOnly || enabled(row.is_training_eligible))
      && (!activeOnly || (enabled(row.item_active) && enabled(row.unit_active) && enabled(row.warehouse_active))))
    .map(({ item_active, unit_active, warehouse_active, ...row }) => row);
}

async function getWeeklyDemandAudit(executor) {
  const scopedHistory = `WITH ${demandSeriesCtes("CONVERT(date,'99991231',112)")}, scoped_history AS (
    SELECT h.* FROM dbo.weekly_demand_history h
    INNER JOIN tracked_pairs p ON p.item_id=h.item_id AND p.warehouse_id=h.warehouse_id
  )`;
  const result = await executor.request().query(`
    ${scopedHistory}
    SELECT
      COUNT_BIG(*) AS weekly_row_count,
      SUM(CASE WHEN is_training_eligible = 1 THEN 1 ELSE 0 END) AS eligible_weekly_row_count,
      COUNT(DISTINCT CASE WHEN is_training_eligible = 1 THEN week_start END) AS week_count,
      COUNT(DISTINCT CASE WHEN is_training_eligible = 1 THEN CONCAT(item_id, ':', warehouse_id) END) AS series_count,
      MIN(CASE WHEN is_training_eligible = 1 THEN week_start END) AS first_week_start,
      MAX(CASE WHEN is_training_eligible = 1 THEN week_end END) AS last_week_end,
      SUM(CASE WHEN is_training_eligible = 1 THEN units_sold ELSE 0 END) AS total_units_sold,
      SUM(CASE WHEN is_training_eligible = 1 AND units_sold = 0 THEN 1 ELSE 0 END) AS zero_demand_week_count,
      SUM(CASE WHEN is_training_eligible = 1 THEN stockout_day_count ELSE 0 END) AS stockout_day_count,
      SUM(CASE WHEN is_complete_week = 0 THEN 1 ELSE 0 END) AS incomplete_week_row_count,
      SUM(CASE WHEN is_training_eligible = 0 THEN 1 ELSE 0 END) AS ineligible_week_row_count
    FROM scoped_history;

    ${scopedHistory}
    SELECT
      item_id,
      warehouse_id,
      COUNT_BIG(*) AS week_count,
      MIN(week_start) AS first_week_start,
      MAX(week_start) AS last_week_start,
      SUM(units_sold) AS total_units_sold
    FROM scoped_history
    WHERE is_training_eligible = 1
    GROUP BY item_id, warehouse_id
    ORDER BY warehouse_id, item_id;

    ${scopedHistory}
    SELECT COUNT_BIG(*) AS anomaly_count
    FROM scoped_history
    WHERE is_training_eligible = 1
      AND ABS((opening_inventory + received_quantity + adjustment_quantity - units_sold) - closing_inventory) > 0.0001;

    ${scopedHistory}, ordered_weeks AS (
      SELECT item_id, warehouse_id, week_start, opening_inventory, closing_inventory,
             LAG(week_start) OVER (PARTITION BY item_id, warehouse_id ORDER BY week_start) AS previous_week_start,
             LAG(closing_inventory) OVER (PARTITION BY item_id, warehouse_id ORDER BY week_start) AS previous_closing_inventory
      FROM scoped_history
      WHERE is_training_eligible = 1
    )
    SELECT
      SUM(CASE
          WHEN previous_week_start IS NOT NULL AND DATEDIFF(DAY, previous_week_start, week_start) <> 7
          THEN 1 ELSE 0
      END) AS series_gap_count,
      SUM(CASE
          WHEN previous_closing_inventory IS NOT NULL AND ABS(previous_closing_inventory - opening_inventory) > 0.0001
          THEN 1 ELSE 0
      END) AS inventory_continuity_error_count
    FROM ordered_weeks;
  `);

  return {
    summary: result.recordsets[0][0],
    series: result.recordsets[1],
    anomaly_count: Number(result.recordsets[2][0].anomaly_count),
    series_gap_count: Number(result.recordsets[3][0].series_gap_count),
    inventory_continuity_error_count: Number(result.recordsets[3][0].inventory_continuity_error_count),
  };
}

module.exports = {
  getWeeklyDemandAudit,
  getWeeklyDemandSeries,
};
