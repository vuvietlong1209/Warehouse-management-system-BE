const { CALIBRATION_SOURCE } = require('./rolling');
const SAFETY_STOCK_METHOD = 'signed-error-quantile-r7';
const SERVICE_LEVELS = Object.freeze([0.90, 0.95]);
const LEAD_TIME_DAYS = 7;

// Hyndman-Fan Type 7 (R quantile(type=7), Excel PERCENTILE.INC).
// Sort ALL signed errors; filtering negatives would estimate a different distribution.
function quantileR7(values, probability) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Cần ít nhất một sai số để tính phân vị');
  }
  const samples = Array.from(values);
  if (samples.some(value => value == null || typeof value === 'boolean'
    || (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')) {
    throw new Error('Sai số dự báo phải là số hữu hạn');
  }
  const sorted = samples.map(Number).sort((a, b) => a - b);
  if (sorted.some(value => !Number.isFinite(value))) throw new Error('Sai số dự báo phải là số hữu hạn');
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('Xác suất phân vị phải nằm trong khoảng 0 đến 1');
  }
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index), fraction = index - lower;
  if (fraction === 0) return sorted[lower];
  return (1 - fraction) * sorted[lower] + fraction * sorted[lower + 1];
}

function ceilUnits(value) {
  // Avoid adding a whole unit to e.g. 40.00000000000003 from binary interpolation.
  const nearest = Math.round(value);
  return Math.abs(value - nearest) <= 128 * Number.EPSILON * Math.max(1, Math.abs(value))
    ? nearest : Math.ceil(value);
}

function resolveServiceLevel(value) {
  const serviceLevel = Number(value);
  if (!SERVICE_LEVELS.includes(serviceLevel)) throw new Error('Mức phục vụ chỉ hỗ trợ 0.90 hoặc 0.95');
  return serviceLevel;
}

function calculateReplenishmentRecommendation(input) {
  const forecast = Number(input.forecast);
  const onHand = Number(input.onHand);
  const onOrder = Number(input.onOrder || 0);
  const backorders = Number(input.backorders || 0);
  const leadTimeDays = Number(input.leadTimeDays ?? LEAD_TIME_DAYS);
  if (![forecast, onHand, onOrder, backorders, leadTimeDays].every(Number.isFinite)) {
    throw new Error('Đầu vào tính đề xuất nhập phải là số hữu hạn');
  }
  if (forecast < 0 || onHand < 0 || onOrder < 0 || backorders < 0 || leadTimeDays <= 0) {
    throw new Error('Dự báo, tồn kho và lead time phải hợp lệ, không âm');
  }

  // Both h1 and h2 predict ONE target week's demand, not cumulative two-week demand.
  // A different lead time needs errors for that protection period, not sqrt scaling.
  if (leadTimeDays !== LEAD_TIME_DAYS) throw new Error('Phân vị hiện chỉ hiệu chỉnh cho lead time 7 ngày');
  const serviceLevel = resolveServiceLevel(input.serviceLevel ?? 0.95);
  const residuals = input.residuals || [];
  if (!Array.isArray(residuals) || residuals.length < 2) {
    throw new Error('Cần ít nhất 2 sai số hiệu chỉnh; không được coi thiếu dữ liệu là sai số 0');
  }
  const forecastErrorQuantile = quantileR7(residuals, serviceLevel);
  const safetyStock = ceilUnits(Math.max(0, forecastErrorQuantile));
  const reorderPoint = ceilUnits(forecast + safetyStock);
  const inventoryPosition = onHand + onOrder - backorders;
  const recommendedOrderQuantity = Math.max(0, ceilUnits(reorderPoint - inventoryPosition));

  return {
    service_level: serviceLevel,
    safety_stock_method: SAFETY_STOCK_METHOD,
    error_definition: 'actual_minus_prediction',
    lead_time_days: leadTimeDays,
    forecast_error_quantile: forecastErrorQuantile,
    forecast_lead_time_demand: forecast,
    safety_stock: safetyStock,
    reorder_point: reorderPoint,
    on_hand: onHand,
    on_order: onOrder,
    backorders,
    inventory_position: inventoryPosition,
    recommended_order_quantity: recommendedOrderQuantity,
    needs_replenishment: recommendedOrderQuantity > 0,
  };
}

function buildReplenishmentAnalysis(forecastEvaluation, options = {}) {
  if (!forecastEvaluation || !Array.isArray(forecastEvaluation.series)) {
    throw new Error('Kết quả đánh giá dự báo không hợp lệ');
  }
  const serviceLevel = options.serviceLevel ?? 0.95;
  const defaultLeadTimeDays = options.leadTimeDays ?? LEAD_TIME_DAYS;
  const recommendations = forecastEvaluation.series.map((series) => {
    const latestRow = series.rows[series.rows.length - 1];
    const evaluation = series.evaluation;
    const method = evaluation.deployment_method;
    if (evaluation.calibration_source !== CALIBRATION_SOURCE
      || !Array.isArray(evaluation.calibration_predictions)) {
      throw new Error('Tồn an toàn phải dùng sai số cuốn chiếu ngoài mẫu, không dùng sai số Validation/benchmark');
    }
    if (![1, 2].includes(evaluation.calibration_horizon_weeks)
      || evaluation.calibration_predictions.some(row => row.horizon_weeks !== evaluation.calibration_horizon_weeks)) {
      throw new Error('Sai số hiệu chỉnh phải khớp chân trời dự báo một/hai bước');
    }
    const residuals = evaluation.calibration_predictions.map(
      (observation) => observation.actual - observation.prediction,
    );
    const policy = options.policyBySeries?.[series.key] || {};
    const forecast = policy.forecast ?? evaluation.selected_next_forecast;
    const recommendation = calculateReplenishmentRecommendation({
      forecast,
      onHand: policy.onHand ?? Number(latestRow.closing_inventory),
      onOrder: policy.onOrder ?? 0,
      backorders: policy.backorders ?? 0,
      leadTimeDays: policy.leadTimeDays ?? defaultLeadTimeDays,
      serviceLevel: policy.serviceLevel ?? serviceLevel,
      residuals,
    });
    return {
      key: series.key,
      item_id: series.item_id,
      warehouse_id: series.warehouse_id,
      item_code: series.item_code,
      item_name: series.item_name,
      warehouse_code: series.warehouse_code,
      warehouse_name: series.warehouse_name,
      current_week_start: latestRow.week_start,
      current_week_end: latestRow.week_end,
      current_week_units_sold: policy.currentWeekUnitsSold ?? Number(latestRow.units_sold),
      forecast_next_week: forecast,
      forecast_change: forecast - (policy.currentWeekUnitsSold ?? Number(latestRow.units_sold)),
      deployment_method: method,
      experimental_winner: evaluation.experimental_winner,
      selected_wma_window: evaluation.selected_wma_window,
      validation_mae: evaluation.validation_metrics[method].mae,
      rolling_test_mae: evaluation.rolling_test_metrics?.mae ?? null,
      calibration_horizon_weeks: evaluation.calibration_horizon_weeks,
      calibration_metrics: evaluation.calibration_metrics ?? null,
      selection_source: evaluation.selection_source,
      calibration_source: evaluation.calibration_source,
      calibration_sample_count: residuals.length,
      ...recommendation,
    };
  });

  const itemIds = new Set(
    recommendations.filter((row) => row.needs_replenishment).map((row) => row.item_id),
  );
  return {
    assumptions: {
      default_lead_time_days: Number(defaultLeadTimeDays),
      default_service_level: Number(serviceLevel),
      safety_stock_method: SAFETY_STOCK_METHOD,
      error_definition: 'actual_minus_prediction',
      on_order_default: 0,
      backorders_default: 0,
    },
    kpis: {
      total_current_inventory: recommendations.reduce((total, row) => total + row.on_hand, 0),
      total_forecast_next_week: recommendations.reduce((total, row) => total + row.forecast_next_week, 0),
      total_safety_stock: recommendations.reduce((total, row) => total + row.safety_stock, 0),
      total_reorder_point: recommendations.reduce((total, row) => total + row.reorder_point, 0),
      item_warehouse_requiring_replenishment: recommendations.filter((row) => row.needs_replenishment).length,
      distinct_items_requiring_replenishment: itemIds.size,
      total_recommended_order_quantity: recommendations.reduce(
        (total, row) => total + row.recommended_order_quantity,
        0,
      ),
    },
    recommendations,
  };
}

module.exports = {
  SAFETY_STOCK_METHOD,
  SERVICE_LEVELS,
  LEAD_TIME_DAYS,
  buildReplenishmentAnalysis,
  calculateReplenishmentRecommendation,
  quantileR7,
};
