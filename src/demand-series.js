const { sql } = require('./db');
const { todayKey } = require('./business-date');
const { requireDate, requirePositiveId } = require('./validation');

// The cohort is explicitly enabled on items; new catalog entries default to disabled.
// Original baseline history is immutable. Operational closure starts the following day.
const BASELINE_HISTORY_END_DATE = '2026-09-13';

function demandSeriesCtes(cutoff = '@series_date') {
  return `tracked_pairs AS (
    SELECT h.item_id, h.warehouse_id, MIN(h.demand_date) tracking_start_date
    FROM dbo.daily_demand_history h
    INNER JOIN dbo.items cohort ON cohort.id=h.item_id
    WHERE cohort.forecast_enabled=1 AND h.demand_date<=CONVERT(date,'${BASELINE_HISTORY_END_DATE}',23) AND h.demand_date<=${cutoff}
    GROUP BY h.item_id,h.warehouse_id
  )`;
}

async function getDemandSeries(executor, options = {}) {
  const result = await executor.request()
    .input('series_date', sql.Date, requireDate(options.asOfDate || todayKey()))
    .input('warehouse_id', sql.Int, options.warehouseId ? requirePositiveId(options.warehouseId, 'Kho') : null)
    .input('active_only', sql.Bit, options.activeOnly === true)
    .query(`WITH ${demandSeriesCtes()}
      SELECT p.*, i.code item_code, i.name item_name, w.code warehouse_code, w.name warehouse_name
      FROM tracked_pairs p JOIN dbo.items i ON i.id=p.item_id
      JOIN dbo.base_units u ON u.id=i.base_unit_id JOIN dbo.warehouses w ON w.id=p.warehouse_id
      WHERE (@warehouse_id IS NULL OR p.warehouse_id=@warehouse_id)
        AND (@active_only=0 OR (i.status=1 AND u.status=1 AND w.status=1))
      ORDER BY p.warehouse_id,p.item_id;`);
  return result.recordset;
}

module.exports = { BASELINE_HISTORY_END_DATE, demandSeriesCtes, getDemandSeries };
