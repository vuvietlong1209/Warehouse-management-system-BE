const { getPool } = require('../src/db');
const { getWeeklyDemandAudit } = require('../src/weekly-demand');

function dateKey(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

async function main() {
  const pool = await getPool();
  try {
    const audit = await getWeeklyDemandAudit(pool);
    const summary = audit.summary;
    const weekCounts = audit.series.map((row) => Number(row.week_count));
    const report = {
      weekly_rows_all: Number(summary.weekly_row_count),
      weekly_rows_training: Number(summary.eligible_weekly_row_count),
      series: Number(summary.series_count),
      complete_weeks_per_series_min: Math.min(...weekCounts),
      complete_weeks_per_series_max: Math.max(...weekCounts),
      first_training_week: dateKey(summary.first_week_start),
      last_training_week: dateKey(summary.last_week_end),
      total_units_sold_training: Number(summary.total_units_sold),
      zero_demand_weeks: Number(summary.zero_demand_week_count),
      stockout_days: Number(summary.stockout_day_count),
      excluded_incomplete_rows: Number(summary.incomplete_week_row_count),
      balance_errors: audit.anomaly_count,
      missing_week_gaps: audit.series_gap_count,
      inventory_continuity_errors: audit.inventory_continuity_error_count,
    };
    console.log(JSON.stringify(report, null, 2));

    if (
      report.series === 0
      || report.complete_weeks_per_series_min !== report.complete_weeks_per_series_max
      || report.balance_errors !== 0
      || report.missing_week_gaps !== 0
      || report.inventory_continuity_errors !== 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

