const { getPool, sql } = require('../src/db');
const { BASELINE_HISTORY_END_DATE } = require('../src/demand-series');
const { getWeeklyDemandSeries } = require('../src/weekly-demand');
const { evaluateHistoricalBenchmark, HISTORICAL_BENCHMARK } = require('../src/forecasting/evaluation');
const { profileDemand } = require('../src/forecasting/error-diagnostics');

async function main() {
  const pool = await getPool();
  try {
    // SELECT only. Imported days are not inferred from missing records or rewritten.
    const daily = await pool.request()
      .input('baseline_end', sql.Date, BASELINE_HISTORY_END_DATE)
      .query(`SELECT h.demand_date, h.units_sold
        FROM dbo.daily_demand_history h JOIN dbo.items i ON i.id=h.item_id
        WHERE i.forecast_enabled=1 AND h.demand_date<=@baseline_end ORDER BY h.demand_date, h.item_id, h.warehouse_id`);
    const weekly = await getWeeklyDemandSeries(pool, { toDate: HISTORICAL_BENCHMARK.to_date });
    const evaluation = evaluateHistoricalBenchmark(weekly);
    const diagnostics = evaluation.error_diagnostics;
    const comparison = Object.fromEntries(Object.entries(diagnostics.test_mase).map(([method, scaled]) => {
      const metrics = method === 'selected_by_series'
        ? evaluation.deployment_portfolio_metrics : evaluation.aggregate_metrics[method];
      return [method, { mae: metrics.mae, mape_nonzero: metrics.mape_nonzero,
        mape_coverage_count: metrics.mape_coverage_count, mase: scaled.mase,
        mase_coverage_count: scaled.coverage_count, count: metrics.count }];
    }));
    console.log(JSON.stringify({
      baseline_end: BASELINE_HISTORY_END_DATE, series_count: evaluation.series_count,
      daily_import_period: { from_date: daily.recordset[0]?.demand_date, to_date: daily.recordset.at(-1)?.demand_date },
      daily_import_profile: profileDemand(daily.recordset.map(row => row.units_sold)),
      eligible_weekly_profile: profileDemand(evaluation.series.flatMap(series => series.values)),
      benchmark_period: { train: evaluation.metadata.train, validation: evaluation.metadata.validation,
        test: { from_date: evaluation.metadata.test.from_date, to_date: evaluation.metadata.test.to_date,
          weeks_per_series: evaluation.metadata.test.count } },
      retrospective_status: evaluation.metadata.benchmark.status,
      data_hash: evaluation.metadata.data_hash, comparison,
      error_diagnostics: { ...diagnostics, series: process.argv.includes('--details') ? diagnostics.series : undefined },
    }, null, 2));
  } finally { await pool.close(); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { main };
