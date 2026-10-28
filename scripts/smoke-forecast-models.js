const { getPool } = require('../src/db');
const { getWeeklyDemandSeries } = require('../src/weekly-demand');
const {
  DEFAULT_WMA_WINDOWS,
  forecastLinearRegression,
  forecastNaive,
  forecastWeightedMovingAverage,
} = require('../src/forecasting/models');
const { prepareForecastCoverage } = require('../src/forecasting/coverage');
const { todayKey } = require('../src/business-date');
const { getDemandSeries } = require('../src/demand-series');

function groupSeries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.item_id}:${row.warehouse_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(row.units_sold));
  }
  return groups;
}

function summarize(values) {
  if (!values.length) return { count: 0, minimum: null, maximum: null, average: null };
  return {
    count: values.length,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    average: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

async function main() {
  const pool = await getPool();
  try {
    const [rows, registered] = await Promise.all([
      getWeeklyDemandSeries(pool, { activeOnly: true }),
      getDemandSeries(pool, { activeOnly: true }),
    ]);
    const today = new Date(todayKey() + 'T00:00:00Z');
    today.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7) - 7);
    const coverage = prepareForecastCoverage(rows, today.toISOString().slice(0, 10), registered);
    const series = groupSeries(coverage.ready_rows);
    const predictions = { naive: [], wma: [], linear_regression: [] };

    for (const history of series.values()) {
      predictions.naive.push(forecastNaive(history));
      for (const windowSize of DEFAULT_WMA_WINDOWS) {
        predictions.wma.push(forecastWeightedMovingAverage(history, { windowSize }));
      }
      predictions.linear_regression.push(forecastLinearRegression(history));
    }

    const allPredictions = Object.values(predictions).flat();
    const invalidPredictionCount = allPredictions.filter(
      (value) => !Number.isFinite(value) || value < 0,
    ).length;
    const report = {
      series_count: series.size,
      unavailable_series_count: coverage.metadata.unavailable_series_count,
      weeks_per_series_minimum: series.size ? Math.min(...[...series.values()].map((history) => history.length)) : null,
      weeks_per_series_maximum: series.size ? Math.max(...[...series.values()].map((history) => history.length)) : null,
      wma_windows: DEFAULT_WMA_WINDOWS,
      naive: summarize(predictions.naive),
      wma: summarize(predictions.wma),
      linear_regression: summarize(predictions.linear_regression),
      invalid_or_negative_predictions: invalidPredictionCount,
    };
    console.log(JSON.stringify(report, null, 2));
    if (series.size === 0 || invalidPredictionCount !== 0) process.exitCode = 1;
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

