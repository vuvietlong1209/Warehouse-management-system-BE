const crypto = require('node:crypto');
const { buildErrorDiagnostics } = require('./error-diagnostics');
const {
  DEFAULT_WMA_WINDOWS,
  forecastLinearRegression,
  forecastNaive,
  forecastWeightedMovingAverage,
} = require('./models');

const DEFAULT_INITIAL_TRAIN_SIZE = 64; // Development = Train + Validation (legacy option name).
const DEFAULT_WMA_VALIDATION_SIZE = 12;
const DEFAULT_TEST_SIZE = 24;
const PROTOCOL_VERSION = 'validation-locked-walk-forward-v2';
const HISTORICAL_BENCHMARK = Object.freeze({
  from_date: '2025-01-06', to_date: '2026-09-13',
  development_size: 64, validation_size: 12, test_size: 24,
  status: 'retrospective_previously_inspected',
});
const METHODS = ['naive', 'wma', 'linear_regression'];
const DAY_MS = 86400000;

function calculateMetrics(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error('Cần ít nhất một quan sát để tính chỉ số sai số');
  }
  let absoluteErrorTotal = 0, signedErrorTotal = 0, absolutePercentageErrorTotal = 0;
  let nonZeroActualCount = 0, actualTotal = 0;
  for (const observation of observations) {
    const actual = Number(observation.actual), prediction = Number(observation.prediction);
    if (!Number.isFinite(actual) || actual < 0 || !Number.isFinite(prediction) || prediction < 0) {
      throw new Error('Quan sát đánh giá phải chứa actual và prediction hữu hạn không âm');
    }
    const error = prediction - actual;
    absoluteErrorTotal += Math.abs(error);
    signedErrorTotal += error;
    actualTotal += actual;
    if (actual > 0) {
      absolutePercentageErrorTotal += Math.abs(error) / actual;
      nonZeroActualCount += 1;
    }
  }
  return {
    count: observations.length, mae: absoluteErrorTotal / observations.length,
    mape_nonzero: nonZeroActualCount ? absolutePercentageErrorTotal / nonZeroActualCount * 100 : null,
    mape_coverage_count: nonZeroActualCount,
    mape_coverage_ratio: nonZeroActualCount / observations.length,
    bias: signedErrorTotal / observations.length,
    wape: actualTotal > 0 ? absoluteErrorTotal / actualTotal * 100 : null,
  };
}

function historyValues(values, minimumLength = 1) {
  if (!Array.isArray(values) || values.length < minimumLength) {
    throw new Error('Không đủ dữ liệu tuần để huấn luyện/đánh giá dự báo');
  }
  return values.map((value, index) => {
    if (value === null || value === '' || typeof value === 'boolean') {
      throw new Error('Nhu cầu tuần ' + index + ' không được thiếu');
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Nhu cầu tuần ' + index + ' phải hữu hạn không âm');
    return parsed;
  });
}

function validationSizeOf(options) {
  const size = Number(options.validationSize ?? options.wmaValidationSize ?? DEFAULT_WMA_VALIDATION_SIZE);
  if (!Number.isInteger(size) || size < 2) throw new Error('Validation phải có ít nhất 2 tuần');
  return size;
}

function forecastByMethod(values, method, windowSize) {
  if (method === 'naive') return forecastNaive(values);
  if (method === 'wma') return forecastWeightedMovingAverage(values, { windowSize });
  if (method === 'linear_regression') return forecastLinearRegression(values);
  throw new Error('Phương pháp dự báo không hợp lệ');
}

function predictRange(history, start, end, method, windowSize) {
  const observations = [];
  for (let targetIndex = start; targetIndex < end; targetIndex += 1) {
    // The current target is never an input, including when re-fitting/standardizing LR.
    const prediction = forecastByMethod(history.slice(0, targetIndex), method, windowSize);
    observations.push({ target_index: targetIndex, actual: history[targetIndex], prediction });
  }
  return observations;
}

function selectWmaWindow(trainingValues, options = {}) {
  const history = historyValues(trainingValues, 10);
  const validationSize = validationSizeOf(options);
  const start = history.length - validationSize;
  if (start < 10) throw new Error('Train trước Validation phải có ít nhất 10 tuần');
  const candidates = options.candidates ?? DEFAULT_WMA_WINDOWS;
  if (!Array.isArray(candidates) || !candidates.length || new Set(candidates).size !== candidates.length) {
    throw new Error('Danh sách cửa sổ WMA không hợp lệ');
  }
  const results = candidates.map(windowSize => {
    if (!Number.isInteger(windowSize) || windowSize <= 0 || windowSize > start) {
      throw new Error('Cửa sổ WMA không phù hợp với tập Train');
    }
    const predictions = predictRange(history, start, history.length, 'wma', windowSize);
    return { window_size: windowSize, metrics: calculateMetrics(predictions), predictions };
  });
  results.sort((a, b) => a.metrics.mae - b.metrics.mae || a.window_size - b.window_size);
  return { selected_window: results[0].window_size, validation_size: validationSize, candidates: results };
}

// This function has no Test parameter. The entire selection/calibration is reproducible from development alone.
function selectForecastModel(developmentValues, options = {}) {
  const validationSize = validationSizeOf(options);
  const history = historyValues(developmentValues, validationSize + 10);
  const start = history.length - validationSize;
  const wmaValidation = selectWmaWindow(history, {
    candidates: options.wmaWindows ?? DEFAULT_WMA_WINDOWS, validationSize,
  });
  const window = wmaValidation.selected_window;
  const predictions = {
    naive: predictRange(history, start, history.length, 'naive'),
    wma: wmaValidation.candidates.find(candidate => candidate.window_size === window).predictions,
    linear_regression: predictRange(history, start, history.length, 'linear_regression'),
  };
  const metrics = Object.fromEntries(METHODS.map(method => [method, calculateMetrics(predictions[method])]));
  const experimentalWinner = metrics.wma.mae <= metrics.linear_regression.mae ? 'wma' : 'linear_regression';
  const method = metrics[experimentalWinner].mae < metrics.naive.mae ? experimentalWinner : 'naive';
  const nextForecasts = Object.fromEntries(METHODS.map(name => [name, forecastByMethod(history, name, window)]));
  return {
    protocol_version: PROTOCOL_VERSION, selection_source: 'validation_walk_forward',
    development_size: history.length, train_size: start, validation_size: validationSize,
    selection_locked_at_index: history.length,
    development_hash: crypto.createHash('sha256').update(JSON.stringify(history)).digest('hex'),
    deployment_method: method, experimental_winner: experimentalWinner,
    selected_wma_window: window, wma_validation: wmaValidation,
    validation_metrics: metrics, validation_predictions: predictions,
    selected_validation_predictions: predictions[method],
    calibration_predictions: predictions[method], calibration_source: 'validation_walk_forward',
    next_forecasts: nextForecasts, selected_next_forecast: nextForecasts[method],
  };
}

// Score a previously locked policy. Test metrics are outputs, never selection inputs.
function evaluateLockedSelection(values, selection, options = {}) {
  const history = historyValues(values);
  const start = selection.development_size;
  const size = Number(options.testSize ?? Math.min(DEFAULT_TEST_SIZE, history.length - start));
  if (selection.selection_source !== 'validation_walk_forward'
    || selection.selection_locked_at_index !== start || !METHODS.includes(selection.deployment_method)
    || !Number.isInteger(start) || start < 10
    || crypto.createHash('sha256').update(JSON.stringify(history.slice(0, start))).digest('hex') !== selection.development_hash) {
    throw new Error('Lựa chọn phải được chốt trên đúng Train/Validation trước Test');
  }
  if (!Number.isInteger(size) || size <= 0 || start + size > history.length) {
    throw new Error('Không đủ tuần Test hợp lệ để đánh giá');
  }
  const predictions = Object.fromEntries(METHODS.map(method => [
    method, predictRange(history, start, start + size, method, selection.selected_wma_window),
  ]));
  const metrics = Object.fromEntries(METHODS.map(method => [method, calculateMetrics(predictions[method])]));
  return {
    predictions, metrics, test_metrics: metrics, test_size: size,
    selected_test_predictions: predictions[selection.deployment_method],
    selected_test_metrics: metrics[selection.deployment_method],
  };
}

function walkForwardEvaluateSeries(values, options = {}) {
  const developmentSize = Number(options.initialTrainSize ?? DEFAULT_INITIAL_TRAIN_SIZE);
  const validationSize = validationSizeOf(options);
  if (!Number.isInteger(developmentSize) || developmentSize < validationSize + 10) {
    throw new Error('Train trước Validation phải có ít nhất 10 tuần');
  }
  const history = historyValues(values, developmentSize + 1);
  const selection = selectForecastModel(history.slice(0, developmentSize), options);
  const test = evaluateLockedSelection(history, selection, options);
  const nextForecasts = Object.fromEntries(METHODS.map(method => [
    method, forecastByMethod(history, method, selection.selected_wma_window),
  ]));
  return {
    ...selection, ...test, initial_train_size: developmentSize,
    next_forecasts: nextForecasts, selected_next_forecast: nextForecasts[selection.deployment_method],
    metadata: {
      protocol_version: PROTOCOL_VERSION, scope: 'historical_holdout',
      selection_source: selection.selection_source, horizon_weeks: 1,
      train: { start_index: 0, end_index: developmentSize - validationSize - 1, count: developmentSize - validationSize },
      validation: { start_index: developmentSize - validationSize, end_index: developmentSize - 1, count: validationSize },
      test: { start_index: developmentSize, end_index: developmentSize + test.test_size - 1, count: test.test_size },
      test_policy: 'fixed_method_and_window_expanding_history',
      ignored_after_test: history.length - developmentSize - test.test_size,
    },
  };
}

function weekKey(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()) || date.getUTCDay() !== 1) {
    throw new Error('Ngày bắt đầu tuần dự báo phải là thứ Hai hợp lệ');
  }
  return date.toISOString().slice(0, 10);
}

function groupWeeklyDemandRows(rows) {
  if (!Array.isArray(rows)) throw new Error('Dữ liệu tuần không hợp lệ');
  const grouped = new Map();
  for (const row of rows) {
    const key = row.item_id + ':' + row.warehouse_id;
    if (row.is_training_eligible === false || row.is_training_eligible === 0
      || row.is_complete_week === false || row.is_complete_week === 0) {
      throw new Error('Không được dùng tuần thiếu/không hợp lệ để dự báo');
    }
    if (!grouped.has(key)) grouped.set(key, {
      key, item_id: Number(row.item_id), warehouse_id: Number(row.warehouse_id),
      item_code: row.item_code, item_name: row.item_name,
      warehouse_code: row.warehouse_code, warehouse_name: row.warehouse_name, rows: [],
    });
    weekKey(row.week_start);
    if (row.week_end) {
      const expectedEnd = new Date(weekKey(row.week_start));
      expectedEnd.setUTCDate(expectedEnd.getUTCDate() + 6);
      if (new Date(row.week_end).toISOString().slice(0, 10) !== expectedEnd.toISOString().slice(0, 10)) {
        throw new Error('Khoảng tuần dự báo không đủ thứ Hai đến Chủ nhật');
      }
    }
    grouped.get(key).rows.push(row);
  }
  for (const series of grouped.values()) {
    series.rows.sort((a, b) => weekKey(a.week_start).localeCompare(weekKey(b.week_start)));
    for (let index = 1; index < series.rows.length; index += 1) {
      if ((new Date(weekKey(series.rows[index].week_start)) - new Date(weekKey(series.rows[index - 1].week_start))) / DAY_MS !== 7) {
        throw new Error('Chuỗi vật tư-kho có tuần trùng hoặc thiếu; không tự điền từ tương lai');
      }
    }
  }
  return grouped;
}

function addDateMetadata(series) {
  const evaluation = series.evaluation;
  if (!evaluation.metadata) return;
  for (const split of ['train', 'validation', 'test']) {
    const segment = evaluation.metadata[split];
    if (!segment) continue;
    const start = weekKey(series.rows[segment.start_index].week_start);
    const end = new Date(weekKey(series.rows[segment.end_index].week_start));
    end.setUTCDate(end.getUTCDate() + 6);
    Object.assign(segment, { from_date: start, to_date: end.toISOString().slice(0, 10) });
  }
}

function summarizeSeries(seriesResults, withTest) {
  const candidates = Object.fromEntries(METHODS.map(method => [method, []]));
  const selectedValidation = [], selectedTest = [];
  const counts = {};
  for (const series of seriesResults) {
    const evaluation = series.evaluation;
    for (const method of METHODS) candidates[method].push(...evaluation.validation_predictions[method]);
    selectedValidation.push(...evaluation.selected_validation_predictions);
    if (withTest) selectedTest.push(...evaluation.selected_test_predictions);
    counts[evaluation.deployment_method] = (counts[evaluation.deployment_method] || 0) + 1;
  }
  const validationMetrics = Object.fromEntries(METHODS.map(method => [method, calculateMetrics(candidates[method])]));
  return {
    protocol_version: PROTOCOL_VERSION,
    series_count: seriesResults.length, deployment_counts: counts,
    aggregate_validation_metrics: validationMetrics,
    selected_validation_metrics: calculateMetrics(selectedValidation),
    aggregate_experimental_winner: validationMetrics.wma.mae <= validationMetrics.linear_regression.mae ? 'wma' : 'linear_regression',
    ...(withTest ? { deployment_portfolio_metrics: calculateMetrics(selectedTest) } : {}),
    series: seriesResults,
  };
}

function evaluateWeeklyDemandRows(rows, options = {}) {
  const grouped = groupWeeklyDemandRows(rows);
  if (!grouped.size) throw new Error('Không có chuỗi nhu cầu tuần để đánh giá');
  const results = [...grouped.values()].map(series => {
    const values = series.rows.map(row => row.units_sold);
    const result = { ...series, values, evaluation: walkForwardEvaluateSeries(values, options) };
    addDateMetadata(result);
    return result;
  });
  const cuts = results.map(series => JSON.stringify({
    train: series.evaluation.metadata.train, validation: series.evaluation.metadata.validation,
    test_start: series.evaluation.metadata.test.from_date,
  }));
  if (new Set(cuts).size !== 1) throw new Error('Các chuỗi so sánh phải dùng cùng ranh giới Train/Validation/Test');
  const summary = summarizeSeries(results, true);
  const aggregateMetrics = Object.fromEntries(METHODS.map(method => [
    method, calculateMetrics(results.flatMap(series => series.evaluation.predictions[method])),
  ]));
  return {
    ...summary, aggregate_metrics: aggregateMetrics,
    test_predictions_per_method: aggregateMetrics.naive.count,
    metadata: { ...results[0].evaluation.metadata,
      test: { ...results[0].evaluation.metadata.test, counts_by_series: results.map(series => ({
        key: series.key, count: series.evaluation.test_size,
        to_date: series.evaluation.metadata.test.to_date,
      })) } },
  };
}

function evaluateHistoricalBenchmark(rows) {
  const selected = rows.filter(row => {
    const key = weekKey(row.week_start);
    return key >= HISTORICAL_BENCHMARK.from_date && key <= HISTORICAL_BENCHMARK.to_date;
  });
  let groups;
  try { groups = groupWeeklyDemandRows(selected); }
  catch (error) {
    // Data-contract failures belong to this benchmark, not operational forecasting.
    error.code = 'FORECAST_BENCHMARK_UNAVAILABLE';
    throw error;
  }
  if (!groups.size || [...groups.values()].some(series => series.rows.length !== 88
    || weekKey(series.rows[0].week_start) !== HISTORICAL_BENCHMARK.from_date)) {
    const error = new Error('Chưa đủ 88 tuần của bộ đánh giá hồi cứu cố định');
    error.code = 'FORECAST_BENCHMARK_UNAVAILABLE';
    throw error;
  }
  const result = evaluateWeeklyDemandRows(selected, {
    initialTrainSize: HISTORICAL_BENCHMARK.development_size,
    validationSize: HISTORICAL_BENCHMARK.validation_size,
    testSize: HISTORICAL_BENCHMARK.test_size,
  });
  result.metadata.benchmark = { ...HISTORICAL_BENCHMARK,
    note: 'Test cũ đã từng được tham khảo; đây là đánh giá hồi cứu sau sửa, không phải Test chưa từng sử dụng.' };
  result.metadata.data_hash = crypto.createHash('sha256').update(JSON.stringify(
    result.series.map(series => ({ key: series.key, rows: series.rows.map(row => [weekKey(row.week_start), Number(row.units_sold)]) })),
  )).digest('hex');
  // Evaluate the already locked selections; this cannot influence model selection/calibration.
  result.error_diagnostics = buildErrorDiagnostics(result);
  return result;
}

function selectOperationalModels(rows, options = {}) {
  let available = rows;
  if (options.completedThroughDate) {
    const cutoff = options.completedThroughDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff) || Number.isNaN(Date.parse(cutoff))
      || new Date(cutoff).toISOString().slice(0, 10) !== cutoff) {
      throw new Error('Mốc tuần hoàn tất không hợp lệ');
    }
    available = rows.filter(row => {
      const end = new Date(weekKey(row.week_start));
      end.setUTCDate(end.getUTCDate() + 6);
      return end.toISOString().slice(0, 10) <= cutoff;
    });
  }
  const grouped = groupWeeklyDemandRows(available);
  if (!grouped.size) throw new Error('Không có lịch sử hoàn tất để dự báo');
  const series = [...grouped.values()].map(group => {
    const values = group.rows.map(row => row.units_sold);
    const evaluation = selectForecastModel(values, options);
    const lastWeek = weekKey(group.rows[group.rows.length - 1].week_start);
    const result = { ...group, values, evaluation: { ...evaluation,
      metadata: { scope: 'live_deployment', selection_source: evaluation.selection_source,
        last_completed_week_start: lastWeek, validation_size: evaluation.validation_size,
        calibration_source: evaluation.calibration_source, horizon_weeks: 1,
        train: { start_index: 0, end_index: evaluation.train_size - 1, count: evaluation.train_size },
        validation: { start_index: evaluation.train_size, end_index: values.length - 1, count: evaluation.validation_size },
      } } };
    addDateMetadata(result);
    return result;
  });
  return { ...summarizeSeries(series, false), metadata: {
    scope: 'live_deployment', selection_source: 'validation_walk_forward', horizon_weeks: 1,
    protocol_version: PROTOCOL_VERSION,
    completed_through_date: options.completedThroughDate ?? null,
    selection_periods: [...new Set(series.map(group => JSON.stringify({
      train: group.evaluation.metadata.train, validation: group.evaluation.metadata.validation,
    })))].map(value => JSON.parse(value)),
  } };
}

module.exports = {
  DEFAULT_INITIAL_TRAIN_SIZE, DEFAULT_WMA_VALIDATION_SIZE, DEFAULT_TEST_SIZE,
  HISTORICAL_BENCHMARK, PROTOCOL_VERSION,
  calculateMetrics, selectWmaWindow, selectForecastModel, evaluateLockedSelection,
  walkForwardEvaluateSeries, groupWeeklyDemandRows, evaluateWeeklyDemandRows,
  evaluateHistoricalBenchmark, selectOperationalModels, forecastByMethod,
};
