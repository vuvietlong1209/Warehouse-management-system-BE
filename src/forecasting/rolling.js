const {
  DEFAULT_WMA_VALIDATION_SIZE, selectForecastModel, selectOperationalModels, calculateMetrics,
} = require('./evaluation');
const { forecastFollowingWeek } = require('./horizon');

const ROLLING_PROTOCOL = 'nested-rolling-origin-v1';
const MIN_TRAIN_WEEKS = 10;
const METHODS = ['naive', 'wma', 'linear_regression'];
const metricsOrNull = observations => observations.length ? calculateMetrics(observations) : null;

// Each origin selects on its own past Train/Validation. The target actual is read only after selection.
function replayRollingOrigins(values, options = {}) {
  const validationSize = Number(options.validationSize ?? options.wmaValidationSize ?? DEFAULT_WMA_VALIDATION_SIZE);
  const firstOrigin = Number(options.initialDevelopmentSize ?? MIN_TRAIN_WEEKS + validationSize);
  if (!Number.isInteger(firstOrigin) || firstOrigin < MIN_TRAIN_WEEKS + validationSize) {
    throw new Error('Mốc bắt đầu cuốn chiếu phải đủ Train/Validation');
  }
  // Validates all values, options and the current selection, even when no mature Test exists yet.
  const cache = new Map();
  const current = selectForecastModel(values, options, cache);
  const byHorizon = { 1: [], 2: [] };
  for (let origin = firstOrigin; origin < values.length; origin++) {
    const history = values.slice(0, origin);
    const selection = selectForecastModel(history, options, cache);
    const common = {
      origin_index: origin - 1, selection_locked_at_index: origin,
      train_end_index: origin - validationSize - 1, validation_start_index: origin - validationSize,
      validation_end_index: origin - 1, deployment_method: selection.deployment_method,
      selected_wma_window: selection.selected_wma_window, development_hash: selection.development_hash,
    };
    for (const horizon of [1, 2]) {
      const target = origin + horizon - 1;
      if (target >= values.length) continue; // Unfinished future weeks are never Test observations.
      const forecasts = Object.fromEntries(METHODS.map(method => [method, horizon === 1
        ? selection.next_forecasts[method]
        : forecastFollowingWeek({ values: history, evaluation: { ...selection, deployment_method: method } }, selection.next_forecasts[method])
      ]));
      byHorizon[horizon].push({ ...common, horizon_weeks: horizon, target_index: target,
        actual: Number(values[target]), prediction: forecasts[selection.deployment_method], forecasts });
    }
  }
  return { current, by_horizon: byHorizon };
}

function datedObservation(observation, rows) {
  const key = value => new Date(value).toISOString().slice(0, 10);
  return { ...observation, origin_week_end: key(rows[observation.origin_index].week_end),
    target_week_start: key(rows[observation.target_index].week_start),
    target_week_end: key(rows[observation.target_index].week_end) };
}

function evaluateOperationalModels(rows, options = {}) {
  const horizon = options.horizonWeeks ?? 1;
  if (![1, 2].includes(horizon)) throw new Error('Chân trời cuốn chiếu chỉ hỗ trợ 1 hoặc 2 tuần');
  const result = selectOperationalModels(rows, options);
  for (const series of result.series) {
    const replay = replayRollingOrigins(series.values, options);
    const observations = replay.by_horizon[horizon].map(row => datedObservation(row, series.rows));
    Object.assign(series.evaluation, {
      rolling_protocol: ROLLING_PROTOCOL, rolling_horizon_weeks: horizon,
      rolling_predictions: observations, rolling_test_metrics: metricsOrNull(observations),
      rolling_candidate_metrics: Object.fromEntries(METHODS.map(method => [method,
        metricsOrNull(observations.map(row => ({ actual: row.actual, prediction: row.forecasts[method] }))) ])),
    });
    // Validation remains selection diagnostics. Rolling Test belongs to the full adaptive policy.
    series.evaluation.metadata.rolling = {
      protocol: ROLLING_PROTOCOL, horizon_weeks: horizon, test_count: observations.length,
      first_test_week: observations[0]?.target_week_start ?? null,
      last_test_week: observations.at(-1)?.target_week_end ?? null,
      origin_policy: horizon === 2 ? 'completed_week_with_recursive_current_week_estimate' : 'completed_week_one_step',
      minimum_train_weeks: MIN_TRAIN_WEEKS,
    };
  }
  const pooled = result.series.flatMap(series => series.evaluation.rolling_predictions);
  result.rolling_test_metrics = metricsOrNull(pooled);
  result.rolling_candidate_metrics = Object.fromEntries(METHODS.map(method => [method,
    metricsOrNull(pooled.map(row => ({ actual: row.actual, prediction: row.forecasts[method] }))) ]));
  result.metadata.rolling = {
    protocol: ROLLING_PROTOCOL, horizon_weeks: horizon,
    test_count: pooled.length,
    series: result.series.map(series => ({ key: series.key, ...series.evaluation.metadata.rolling })),
    evaluation_kind: 'retrospective_causal_replay',
  };
  return result;
}

module.exports = { ROLLING_PROTOCOL,
  MIN_TRAIN_WEEKS, replayRollingOrigins, evaluateOperationalModels };
