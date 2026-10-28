const SERVICE_LEVEL_Z = Object.freeze({
  0.90: 1.2815515655446004,
  0.95: 1.6448536269514722,
});

function sampleStandardDeviation(values) {
  if (!Array.isArray(values) || values.length < 2) {
    throw new Error('Cần ít nhất 2 sai số hiệu chỉnh; không được coi thiếu dữ liệu là sai số 0');
  }
  const parsed = values.map(Number);
  if (parsed.some((value) => !Number.isFinite(value))) {
    throw new Error('Sai số dự báo phải là số hữu hạn');
  }
  const average = parsed.reduce((total, value) => total + value, 0) / parsed.length;
  const squaredDeviation = parsed.reduce(
    (total, value) => total + (value - average) ** 2,
    0,
  );
  return Math.sqrt(squaredDeviation / (parsed.length - 1));
}

function resolveServiceLevel(value) {
  const serviceLevel = Number(value);
  const matched = Object.keys(SERVICE_LEVEL_Z).find(
    (candidate) => Math.abs(Number(candidate) - serviceLevel) < 1e-9,
  );
  if (!matched) throw new Error('Mức phục vụ chỉ hỗ trợ 0.90 hoặc 0.95');
  return { serviceLevel, zScore: SERVICE_LEVEL_Z[matched] };
}

function calculateReplenishmentRecommendation(input) {
  const forecast = Number(input.forecast);
  const onHand = Number(input.onHand);
  const onOrder = Number(input.onOrder || 0);
  const backorders = Number(input.backorders || 0);
  const leadTimeDays = Number(input.leadTimeDays ?? 7);
  if (![forecast, onHand, onOrder, backorders, leadTimeDays].every(Number.isFinite)) {
    throw new Error('Đầu vào tính đề xuất nhập phải là số hữu hạn');
  }
  if (forecast < 0 || onHand < 0 || onOrder < 0 || backorders < 0 || leadTimeDays <= 0) {
    throw new Error('Dự báo, tồn kho và lead time phải hợp lệ, không âm');
  }

  const { serviceLevel, zScore } = resolveServiceLevel(input.serviceLevel ?? 0.95);
  const residuals = input.residuals || [];
  const forecastErrorStdDev = sampleStandardDeviation(residuals);
  const leadTimeWeeks = leadTimeDays / 7;
  const leadTimeDemand = forecast * leadTimeWeeks;
  const safetyStock = Math.ceil(zScore * forecastErrorStdDev * Math.sqrt(leadTimeWeeks));
  const reorderPoint = Math.ceil(leadTimeDemand + safetyStock);
  const inventoryPosition = onHand + onOrder - backorders;
  const recommendedOrderQuantity = Math.max(0, Math.ceil(reorderPoint - inventoryPosition));

  return {
    service_level: serviceLevel,
    z_score: zScore,
    lead_time_days: leadTimeDays,
    lead_time_weeks: leadTimeWeeks,
    forecast_error_std_dev: forecastErrorStdDev,
    forecast_lead_time_demand: leadTimeDemand,
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
  const defaultLeadTimeDays = options.leadTimeDays ?? 7;
  const recommendations = forecastEvaluation.series.map((series) => {
    const latestRow = series.rows[series.rows.length - 1];
    const evaluation = series.evaluation;
    const method = evaluation.deployment_method;
    if (evaluation.calibration_source !== 'validation_walk_forward'
      || !Array.isArray(evaluation.calibration_predictions)) {
      throw new Error('Tồn an toàn phải dùng sai số hiệu chỉnh Validation, không dùng Test');
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
      // Legacy names retain Test semantics; a live-only selection has no independent Test score.
      selected_model_mae: evaluation.selected_test_metrics?.mae ?? null,
      selected_model_mape_nonzero: evaluation.selected_test_metrics?.mape_nonzero ?? null,
      validation_mae: evaluation.validation_metrics[method].mae,
      test_mae: evaluation.selected_test_metrics?.mae ?? null,
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
  SERVICE_LEVEL_Z,
  buildReplenishmentAnalysis,
  calculateReplenishmentRecommendation,
  sampleStandardDeviation,
};
