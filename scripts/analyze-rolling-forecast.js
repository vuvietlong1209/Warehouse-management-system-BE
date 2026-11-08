const { getPool } = require('../src/db');
const { todayKey } = require('../src/business-date');
const { getWeeklyDemandSeries } = require('../src/weekly-demand');
const { getDemandSeries } = require('../src/demand-series');
const { prepareForecastCoverage } = require('../src/forecasting/coverage');
const { evaluateOperationalModels } = require('../src/forecasting/rolling');
const { buildReplenishmentAnalysis } = require('../src/forecasting/replenishment');
const { forecastFollowingWeek } = require('../src/forecasting/horizon');

async function main() {
  const pool = await getPool();
  try {
    const today = todayKey(), week = new Date(today + 'T00:00:00Z');
    week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7 - 7);
    const start = week.toISOString().slice(0, 10);
    week.setUTCDate(week.getUTCDate() + 6);
    const cutoff = week.toISOString().slice(0, 10);
    const [rows, registered] = await Promise.all([
      getWeeklyDemandSeries(pool, { activeOnly: true, completeOnly: false, toDate: cutoff }),
      getDemandSeries(pool, { activeOnly: true, asOfDate: today }),
    ]);
    const results = {};
    for (const horizonWeeks of [1, 2]) {
      const coverage = prepareForecastCoverage(rows, start, registered);
      const result = coverage.ready_rows.length ? evaluateOperationalModels(coverage.ready_rows,
        { completedThroughDate: cutoff, horizonWeeks }) : null;
      const replenishment = result ? buildReplenishmentAnalysis(result, {
        policyBySeries: Object.fromEntries(result.series.map(series => [series.key, {
          forecast: horizonWeeks === 2
            ? forecastFollowingWeek(series, series.evaluation.selected_next_forecast)
            : series.evaluation.selected_next_forecast,
        }])),
      }) : null;
      results[horizonWeeks] = {
        scope: 'retrospective_causal_replay', complete_through_date: cutoff,
        ready_series: coverage.metadata.ready_series_count, unavailable_series: coverage.metadata.unavailable_series_count,
        test_metrics: result?.rolling_test_metrics ?? null,
        candidates: result?.rolling_candidate_metrics ?? null,
        metadata: result?.metadata.rolling ?? null,
        replenishment: replenishment ? { scope: 'completed_week_boundary_not_live_stock',
          assumptions: replenishment.assumptions, kpis: replenishment.kpis } : null,
        series: result?.series.map((series, index) => ({ key: series.key, item_code: series.item_code,
          warehouse_code: series.warehouse_code, current_method: series.evaluation.deployment_method,
          current_validation_mae: series.evaluation.validation_metrics[series.evaluation.deployment_method].mae,
          rolling_test_metrics: series.evaluation.rolling_test_metrics,
          replenishment: replenishment.recommendations[index],
          ...(process.argv.includes('--details') ? { observations: series.evaluation.rolling_predictions } : {}),
        })) ?? [],
      };
    }
    console.log(JSON.stringify(results, null, 2));
  } finally { await pool.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
