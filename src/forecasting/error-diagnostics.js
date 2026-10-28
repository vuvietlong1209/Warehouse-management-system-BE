// Supplementary scoring only: never used to select or refit a forecasting model.
const METHODS = ['naive', 'wma', 'linear_regression', 'selected_by_series'];

function quantity(value) {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') {
    throw new Error('Dữ liệu chẩn đoán không được thiếu');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Dữ liệu chẩn đoán phải hữu hạn không âm');
  return number;
}

function profileDemand(values) {
  const sorted = values.map(quantity).sort((a, b) => a - b);
  const count = sorted.length;
  const zeroCount = sorted.filter(value => value === 0).length;
  return {
    count, zero_count: zeroCount, zero_ratio: count ? zeroCount / count : null,
    positive_le_5_count: sorted.filter(value => value > 0 && value <= 5).length,
    positive_le_10_count: sorted.filter(value => value > 0 && value <= 10).length,
    minimum: count ? sorted[0] : null,
    median: count ? (sorted[Math.floor((count - 1) / 2)] + sorted[Math.floor(count / 2)]) / 2 : null,
    maximum: count ? sorted[count - 1] : null,
    total_actual: sorted.reduce((total, value) => total + value, 0),
  };
}

function naiveTrainingScale(trainingValues) {
  if (!Array.isArray(trainingValues) || trainingValues.length < 2) {
    throw new Error('MASE cần ít nhất hai tuần Train');
  }
  const history = trainingValues.map(quantity);
  return history.slice(1).reduce((total, value, index) => total + Math.abs(value - history[index]), 0)
    / (history.length - 1);
}

function summarizeMase(groups) {
  let scaledErrorTotal = 0, count = 0, coverageCount = 0, eligibleSeriesCount = 0;
  for (const { trainingValues, observations } of groups) {
    const scale = naiveTrainingScale(trainingValues);
    if (scale > 0 && observations.length) eligibleSeriesCount += 1;
    for (const observation of observations) {
      const error = Math.abs(quantity(observation.prediction) - quantity(observation.actual));
      count += 1;
      // Constant Train (including all-zero Train) has an undefined scale, not perfect accuracy.
      if (scale > 0) { scaledErrorTotal += error / scale; coverageCount += 1; }
    }
  }
  return {
    mase: coverageCount ? scaledErrorTotal / coverageCount : null,
    count, coverage_count: coverageCount, coverage_ratio: count ? coverageCount / count : null,
    series_count: groups.length, eligible_series_count: eligibleSeriesCount,
    undefined_series_count: groups.length - eligibleSeriesCount,
    scale_source: 'train_only_before_validation', naive_lag_weeks: 1,
    aggregation: 'mean_per_observation_scaled_absolute_error',
  };
}

function percentageErrorBreakdown(observations) {
  const bins = ['zero', 'positive_le_5', 'positive_gt_5_le_10', 'positive_gt_10'].map(range => ({
    range, count: 0, actual_total: 0, absolute_error_total: 0, ape_total: 0,
  }));
  for (const observation of observations) {
    const actual = quantity(observation.actual), prediction = quantity(observation.prediction);
    const bin = bins[actual === 0 ? 0 : actual <= 5 ? 1 : actual <= 10 ? 2 : 3];
    const error = Math.abs(prediction - actual);
    bin.count += 1; bin.actual_total += actual; bin.absolute_error_total += error;
    if (actual > 0) bin.ape_total += error / actual;
  }
  const apeTotal = bins.reduce((total, bin) => total + bin.ape_total, 0);
  return {
    small_positive_threshold: 10, threshold_use: 'descriptive_only_not_model_selection',
    zero_actual_count: bins[0].count,
    mape_coverage_count: observations.length - bins[0].count,
    small_positive_count: bins[1].count + bins[2].count,
    small_positive_mape_contribution_percent: apeTotal ? (bins[1].ape_total + bins[2].ape_total) / apeTotal * 100 : null,
    bins: bins.map(bin => ({ ...bin,
      mape_contribution_percent: bin.range !== 'zero' && apeTotal ? bin.ape_total / apeTotal * 100 : null,
    })),
  };
}

function buildErrorDiagnostics(evaluation) {
  const groups = evaluation.series.map(series => {
    const result = series.evaluation;
    const train = result.metadata.train;
    const trainingValues = series.values.slice(train.start_index, train.end_index + 1);
    if (train.end_index >= result.development_size - result.validation_size) {
      throw new Error('Mẫu số MASE chỉ được dùng Train, không dùng Validation/Test');
    }
    return { series, trainingValues, result };
  });
  const observationsFor = (group, method) => method === 'selected_by_series'
    ? group.result.selected_test_predictions : group.result.predictions[method];
  const selected = groups.flatMap(group => observationsFor(group, 'selected_by_series'));
  return {
    supplementary_metric: 'MASE', selection_metric_unchanged: 'validation_mae',
    evaluation_frequency: 'weekly', evaluation_horizon_weeks: 1,
    scale_policy: 'lag_1_naive_on_train_only_frozen_before_validation_and_test',
    zero_scale_policy: 'null_and_explicit_coverage_no_epsilon',
    demand_profile: {
      train: profileDemand(groups.flatMap(group => group.trainingValues)),
      validation: profileDemand(groups.flatMap(group => group.result.selected_validation_predictions.map(row => row.actual))),
      test: profileDemand(selected.map(row => row.actual)),
    },
    test_mase: Object.fromEntries(METHODS.map(method => [method, summarizeMase(groups.map(group => ({
      trainingValues: group.trainingValues, observations: observationsFor(group, method),
    })))])),
    selected_validation_mase: summarizeMase(groups.map(group => ({
      trainingValues: group.trainingValues, observations: group.result.selected_validation_predictions,
    }))),
    selected_test_mape_diagnostics: percentageErrorBreakdown(selected),
    series: groups.map(group => ({
      key: group.series.key, item_code: group.series.item_code, warehouse_code: group.series.warehouse_code,
      selected_method: group.result.deployment_method,
      train_count: group.trainingValues.length, train_naive_error_count: group.trainingValues.length - 1,
      train_naive_mae: naiveTrainingScale(group.trainingValues),
      selected_test_mase: summarizeMase([{
        trainingValues: group.trainingValues, observations: group.result.selected_test_predictions,
      }]),
    })),
  };
}

module.exports = { profileDemand, naiveTrainingScale, summarizeMase, percentageErrorBreakdown, buildErrorDiagnostics };
