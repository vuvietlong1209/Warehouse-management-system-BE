const { getPool } = require('../src/db');
const { getWeeklyDemandSeries } = require('../src/weekly-demand');
const { evaluateHistoricalBenchmark } = require('../src/forecasting/evaluation');
const { buildReplenishmentAnalysis } = require('../src/forecasting/replenishment');

function roundedMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([method, values]) => [method, {
    count: values.count,
    mae: Number(values.mae.toFixed(4)),
    mape_nonzero: values.mape_nonzero === null ? null : Number(values.mape_nonzero.toFixed(4)),
    mape_coverage_count: values.mape_coverage_count,
    mape_coverage_ratio: Number(values.mape_coverage_ratio.toFixed(4)),
    bias: Number(values.bias.toFixed(4)),
    wape: values.wape === null ? null : Number(values.wape.toFixed(4)),
  }]));
}

async function main() {
  const pool = await getPool();
  try {
    const weeklyRows = await getWeeklyDemandSeries(pool);
    const evaluation = evaluateHistoricalBenchmark(weeklyRows);
    const replenishment95 = buildReplenishmentAnalysis(evaluation, {
      leadTimeDays: 7,
      serviceLevel: 0.95,
    });
    const replenishment90 = buildReplenishmentAnalysis(evaluation, {
      leadTimeDays: 7,
      serviceLevel: 0.90,
    });
    const topRecommendations = replenishment95.recommendations
      .filter((row) => row.needs_replenishment)
      .sort((left, right) => right.recommended_order_quantity - left.recommended_order_quantity)
      .slice(0, 10)
      .map((row) => ({
        item_code: row.item_code,
        item_name: row.item_name,
        warehouse_code: row.warehouse_code,
        warehouse_name: row.warehouse_name,
        method: row.deployment_method,
        on_hand: row.on_hand,
        forecast_next_week: Number(row.forecast_next_week.toFixed(4)),
        safety_stock: row.safety_stock,
        reorder_point: row.reorder_point,
        recommended_order_quantity: row.recommended_order_quantity,
      }));

    console.log(JSON.stringify({
      evaluation: {
        series_count: evaluation.series_count,
        protocol: evaluation.metadata,
        initial_train_weeks: evaluation.metadata.train.count,
        development_weeks: evaluation.metadata.train.count + evaluation.metadata.validation.count,
        validation_weeks: evaluation.metadata.validation.count,
        test_weeks: evaluation.metadata.test.count,
        predictions_per_method: evaluation.test_predictions_per_method,
        aggregate_metrics: roundedMetrics(evaluation.aggregate_metrics),
        error_diagnostics: evaluation.error_diagnostics,
        aggregate_validation_metrics: roundedMetrics(evaluation.aggregate_validation_metrics),
        selected_validation_metrics: roundedMetrics({ selected: evaluation.selected_validation_metrics }).selected,
        deployment_portfolio_metrics: roundedMetrics({
          selected_by_series: evaluation.deployment_portfolio_metrics,
        }).selected_by_series,
        aggregate_experimental_winner: evaluation.aggregate_experimental_winner,
        deployment_counts: evaluation.deployment_counts,
        selected_wma_windows: evaluation.series.reduce((counts, series) => {
          const window = series.evaluation.selected_wma_window;
          counts[window] = (counts[window] || 0) + 1;
          return counts;
        }, {}),
        series: evaluation.series.map(series => ({
          key: series.key, item_code: series.item_code, warehouse_code: series.warehouse_code,
          method: series.evaluation.deployment_method,
          wma_window: series.evaluation.selected_wma_window,
          selection_source: series.evaluation.selection_source,
          validation_mae: series.evaluation.validation_metrics[series.evaluation.deployment_method].mae,
          test: roundedMetrics({ selected: series.evaluation.selected_test_metrics }).selected,
        })),
      },
      replenishment: {
        scope: 'historical_snapshot_not_live_stock',
        calibration_source: 'validation_walk_forward',
        calibration_sample_count_per_series: evaluation.metadata.validation.count,
        assumptions: replenishment95.assumptions,
        kpis: {
          ...replenishment95.kpis,
          total_forecast_next_week: Number(replenishment95.kpis.total_forecast_next_week.toFixed(4)),
        },
        service_level_sensitivity: {
          '90_percent': replenishment90.kpis,
          '95_percent': replenishment95.kpis,
        },
        top_recommendations: topRecommendations,
      },
    }, null, 2));
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
