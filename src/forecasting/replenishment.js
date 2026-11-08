const { isCompleteDemandWeek } = require('./coverage');
const SAFETY_STOCK_METHOD = 'weekly-max-minus-positive-mean';
const SAFETY_STOCK_SOURCE = 'completed_weekly_issues';
const SAFETY_STOCK_WINDOW_WEEKS = 12;
const LEAD_TIME_DAYS = 7;

function ceilUnits(value) {
  // Avoid adding a phantom unit when subtracting a floating-point average.
  const nearest = Math.round(value);
  return Math.abs(value - nearest) <= 128 * Number.EPSILON * Math.max(1, Math.abs(value))
    ? nearest : Math.ceil(value);
}

function calculateSafetyStock(weeklyDemand) {
  if (!Array.isArray(weeklyDemand) || weeklyDemand.length !== SAFETY_STOCK_WINDOW_WEEKS) {
    throw new Error('Tồn an toàn cần đúng 12 tuần lịch sử đã hoàn tất');
  }
  const values = Array.from(weeklyDemand, value => {
    if (value == null || typeof value === 'boolean'
      || !['number', 'string'].includes(typeof value) || String(value).trim() === ''
      || !Number.isFinite(Number(value)) || Number(value) < 0) {
      throw new Error('Lượng xuất mỗi tuần phải là số hữu hạn, không âm; không được coi thiếu dữ liệu là 0');
    }
    return Number(value);
  });
  const positive = values.filter(value => value > 0);
  const maximum = Math.max(...values);
  const average = positive.length ? positive.reduce((sum, value) => sum + value, 0) / positive.length : 0;
  // Weekly demand × (7 days / 7 days) on both sides: no extra factor of seven.
  return {
    safety_stock_method: SAFETY_STOCK_METHOD,
    safety_stock_source: SAFETY_STOCK_SOURCE,
    safety_stock_window_weeks: SAFETY_STOCK_WINDOW_WEEKS,
    maximum_weekly_demand: maximum,
    average_positive_weekly_demand: average,
    positive_demand_week_count: positive.length,
    zero_demand_week_count: values.length - positive.length,
    safety_stock: ceilUnits(Math.max(0, maximum - average)),
  };
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

  if (leadTimeDays !== LEAD_TIME_DAYS) throw new Error('Thời gian giao hàng trung bình và tối đa hiện cố định 7 ngày');
  const safety = calculateSafetyStock(input.weeklyDemand);
  const reorderPoint = ceilUnits(forecast + safety.safety_stock);
  const inventoryPosition = onHand + onOrder - backorders;
  const recommendedOrderQuantity = Math.max(0, ceilUnits(reorderPoint - inventoryPosition));

  return {
    ...safety,
    lead_time_days: leadTimeDays,
    forecast_lead_time_demand: forecast,
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
  if (forecastEvaluation.metadata?.scope !== 'live_deployment') {
    throw new Error('Tồn an toàn chỉ dùng lịch sử dự báo vận hành đã hoàn tất, không dùng kết quả benchmark');
  }
  const defaultLeadTimeDays = options.leadTimeDays ?? LEAD_TIME_DAYS;
  const recommendations = forecastEvaluation.series.map((series) => {
    const recent = series.rows.slice(-SAFETY_STOCK_WINDOW_WEEKS);
    if (recent.length !== SAFETY_STOCK_WINDOW_WEEKS || !recent.every(isCompleteDemandWeek)) {
      throw new Error('Tồn an toàn cần đủ 12 tuần hoàn tất, không thiếu ngày hoặc tự điền tuần 0');
    }
    if (recent.some((row, index) => index > 0
      && new Date(row.week_start) - new Date(recent[index - 1].week_start) !== 7 * 86400000)) {
      throw new Error('Cửa sổ tồn an toàn phải gồm 12 tuần liên tiếp');
    }
    const latestRow = recent.at(-1);
    const evaluation = series.evaluation;
    const method = evaluation.deployment_method;
    const policy = options.policyBySeries?.[series.key] || {};
    const forecast = policy.forecast ?? evaluation.selected_next_forecast;
    const recommendation = calculateReplenishmentRecommendation({
      forecast,
      onHand: policy.onHand ?? Number(latestRow.closing_inventory),
      onOrder: policy.onOrder ?? 0,
      backorders: policy.backorders ?? 0,
      leadTimeDays: policy.leadTimeDays ?? defaultLeadTimeDays,
      weeklyDemand: recent.map(row => row.units_sold),
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
      selection_source: evaluation.selection_source,
      safety_stock_window_start: new Date(recent[0].week_start).toISOString().slice(0, 10),
      safety_stock_window_end: new Date(latestRow.week_end).toISOString().slice(0, 10),
      ...recommendation,
    };
  });

  const itemIds = new Set(
    recommendations.filter((row) => row.needs_replenishment).map((row) => row.item_id),
  );
  return {
    assumptions: {
      default_lead_time_days: Number(defaultLeadTimeDays),
      safety_stock_method: SAFETY_STOCK_METHOD,
      safety_stock_source: SAFETY_STOCK_SOURCE,
      safety_stock_window_weeks: SAFETY_STOCK_WINDOW_WEEKS,
      safety_stock_average_basis: 'positive_demand_weeks',
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
  SAFETY_STOCK_SOURCE,
  SAFETY_STOCK_WINDOW_WEEKS,
  LEAD_TIME_DAYS,
  buildReplenishmentAnalysis,
  calculateReplenishmentRecommendation,
  calculateSafetyStock,
};
