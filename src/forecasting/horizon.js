const { forecastLinearRegression, forecastNaive, forecastWeightedMovingAverage } = require('./models');

// Shared by live forecasts and retrospective replay; no future actual is appended.
function forecastFollowingWeek(series, currentWeekEstimate) {
  const values = [...series.values, currentWeekEstimate];
  const method = series.evaluation.deployment_method;
  if (method === 'wma') return forecastWeightedMovingAverage(values, {
    windowSize: series.evaluation.selected_wma_window,
  });
  if (method === 'linear_regression') return forecastLinearRegression(values);
  return forecastNaive(values);
}

module.exports = { forecastFollowingWeek };
