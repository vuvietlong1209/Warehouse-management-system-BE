const { getPool } = require('../src/db');
const { getWeeklyDemandSeries } = require('../src/weekly-demand');
const { evaluateHistoricalBenchmark } = require('../src/forecasting/evaluation');

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
    }, null, 2));
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
