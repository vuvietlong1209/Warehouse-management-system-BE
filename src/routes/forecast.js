const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db');
const { requirePositiveId } = require('../validation');
const { getWeeklyDemandSeries } = require('../weekly-demand');
const { evaluateHistoricalBenchmark, selectOperationalModels, PROTOCOL_VERSION, HISTORICAL_BENCHMARK } = require('../forecasting/evaluation');
const { buildReplenishmentAnalysis } = require('../forecasting/replenishment');
const { prepareForecastCoverage, isCompleteDemandWeek } = require('../forecasting/coverage');
const { forecastFollowingWeek } = require('../forecasting/horizon');
const { demandSeriesCtes, getDemandSeries } = require('../demand-series');
const { todayKey } = require('../business-date');
const { getWeeklyReceivedQuantities, getRecentItemMovements } = require('../forecast-movements');

function dateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = new Date(`${dateKey(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayOfWeek(value) {
  const key = dateKey(value);
  const date = new Date(`${key}T00:00:00.000Z`);
  const daysAfterMonday = (date.getUTCDay() + 6) % 7;
  return addDays(key, -daysAfterMonday);
}

async function getWeeklyIssuedQuantities(pool, warehouseId, fromDate, toDate) {
  const result = await pool.request()
    .input('warehouse_id', sql.Int, warehouseId)
    .input('from_date', sql.Date, fromDate)
    .input('to_date', sql.Date, toDate)
    .query(`
      WITH ${demandSeriesCtes('@to_date')}, forecast_pairs AS (
        SELECT DISTINCT h.item_id, h.warehouse_id
        FROM tracked_pairs h
        INNER JOIN dbo.items i ON i.id = h.item_id AND i.status = 1
        INNER JOIN dbo.base_units bu ON bu.id = i.base_unit_id AND bu.status = 1
        INNER JOIN dbo.warehouses w ON w.id = h.warehouse_id AND w.status = 1
        WHERE h.item_id IS NOT NULL AND h.warehouse_id IS NOT NULL
          AND (@warehouse_id IS NULL OR h.warehouse_id = @warehouse_id)
      )
      SELECT d.item_id, h.warehouse_id,
        CAST(DATEADD(DAY,
          -(DATEDIFF(DAY, CONVERT(date, '19000101', 112), h.order_date) % 7),
          h.order_date
        ) AS date) week_start,
        SUM(d.quantity_ordered) quantity
      FROM dbo.issue_transaction_details d
      INNER JOIN dbo.issue_transactions h ON h.id = d.goods_issue_id
      INNER JOIN forecast_pairs p ON p.item_id = d.item_id AND p.warehouse_id = h.warehouse_id
      WHERE h.issue_status = 'Confirmed' AND h.status = 1
        AND h.order_date BETWEEN @from_date AND @to_date
      GROUP BY d.item_id, h.warehouse_id,
        CAST(DATEADD(DAY,
          -(DATEDIFF(DAY, CONVERT(date, '19000101', 112), h.order_date) % 7),
          h.order_date
        ) AS date);
    `);
  return new Map(result.recordset.map(row => [
    `${Number(row.item_id)}:${Number(row.warehouse_id)}:${dateKey(row.week_start)}`,
    Number(row.quantity) || 0,
  ]));
}

async function getCurrentStocks(pool, warehouseId, asOfDate) {
  const result = await pool.request()
    .input('warehouse_id', sql.Int, warehouseId)
    .input('series_date', sql.Date, asOfDate)
    .query(`
      WITH ${demandSeriesCtes()}, forecast_pairs AS (
        SELECT DISTINCT h.item_id, h.warehouse_id
        FROM tracked_pairs h
        INNER JOIN dbo.items i ON i.id = h.item_id AND i.status = 1
        INNER JOIN dbo.base_units bu ON bu.id = i.base_unit_id AND bu.status = 1
        INNER JOIN dbo.warehouses w ON w.id = h.warehouse_id AND w.status = 1
        WHERE h.item_id IS NOT NULL AND h.warehouse_id IS NOT NULL
          AND (@warehouse_id IS NULL OR h.warehouse_id = @warehouse_id)
      ), receipt_stock AS (
        SELECT d.item_id, h.warehouse_id, SUM(d.quantity_ordered) quantity
        FROM dbo.receipt_transaction_details d
        INNER JOIN dbo.receipt_transactions h ON h.id = d.goods_receipt_id
        WHERE h.receipt_status = 'Confirmed' AND h.status = 1 AND h.order_date<=@series_date
        GROUP BY d.item_id, h.warehouse_id
      ), issue_stock AS (
        SELECT d.item_id, h.warehouse_id, SUM(d.quantity_ordered) quantity
        FROM dbo.issue_transaction_details d
        INNER JOIN dbo.issue_transactions h ON h.id = d.goods_issue_id
        WHERE h.issue_status = 'Confirmed' AND h.status = 1 AND h.order_date<=@series_date
        GROUP BY d.item_id, h.warehouse_id
      ), adjustment_stock AS (
        SELECT d.item_id, h.warehouse_id, SUM(d.discrepancy) quantity
        FROM dbo.inventory_check_details d
        INNER JOIN dbo.inventory_checks h ON h.id = d.inventory_check_id
        WHERE h.check_status = 'Completed' AND h.status = 1 AND d.discrepancy_handled = 1 AND h.to_date<=@series_date
        GROUP BY d.item_id, h.warehouse_id
      )
      SELECT p.item_id, p.warehouse_id,
        CAST(ISNULL(r.quantity, 0) - ISNULL(o.quantity, 0) + ISNULL(a.quantity, 0) AS decimal(18, 4)) current_stock
      FROM forecast_pairs p
      LEFT JOIN receipt_stock r ON r.item_id = p.item_id AND r.warehouse_id = p.warehouse_id
      LEFT JOIN issue_stock o ON o.item_id = p.item_id AND o.warehouse_id = p.warehouse_id
      LEFT JOIN adjustment_stock a ON a.item_id = p.item_id AND a.warehouse_id = p.warehouse_id;
    `);
  return new Map(result.recordset.map(row => [
    `${Number(row.item_id)}:${Number(row.warehouse_id)}`,
    Number(row.current_stock) || 0,
  ]));
}

function aggregateRecommendations(recommendations, search) {
  const byItem = new Map();
  for (const row of recommendations) {
    const current = byItem.get(row.item_id) || {
      item_id: row.item_id,
      item_code: row.item_code,
      item_name: row.item_name,
      current_stock: 0,
      safety_stock: 0,
      current_week_issued: 0,
      current_week_received: 0,
      forecast_next_week_raw: 0,
      recommended_order_quantity: 0,
      warehouse_count: 0,
      replenishment_location_count: 0,
      forecast_status: 'ready',
      stock_available: true,
      issued_available: true,
      unavailable_warehouse_count: 0,
      last_complete_week_end: row.last_complete_week_end ?? null,
    };
    current.current_stock += Number(row.on_hand) || 0;
    if (row.on_hand == null) current.stock_available = false;
    current.safety_stock += Number(row.safety_stock) || 0;
    current.current_week_issued += Number(row.current_week_units_sold) || 0;
    current.current_week_received += Number(row.current_week_received) || 0;
    if (row.current_week_units_sold == null) current.issued_available = false;
    current.forecast_next_week_raw += Number(row.forecast_next_week) || 0;
    current.recommended_order_quantity += Number(row.recommended_order_quantity) || 0;
    current.warehouse_count += 1;
    if (row.forecast_status && row.forecast_status !== 'ready') {
      current.forecast_status = 'unavailable';
      current.unavailable_warehouse_count += 1;
    }
    if (!row.last_complete_week_end || (current.last_complete_week_end && row.last_complete_week_end < current.last_complete_week_end)) {
      current.last_complete_week_end = row.last_complete_week_end ?? null;
    }
    if (row.needs_replenishment) current.replenishment_location_count += 1;
    byItem.set(row.item_id, current);
  }

  const normalizedSearch = String(search || '').trim().toLocaleLowerCase('vi');
  return [...byItem.values()]
    .map(row => ({
      ...row,
      current_stock: row.stock_available ? row.current_stock : null,
      current_week_issued: row.issued_available ? row.current_week_issued : null,
      ...(row.forecast_status !== 'ready' ? {
        safety_stock: null, forecast_next_week_raw: null, recommended_order_quantity: null,
      } : {}),
      forecast_next_week: row.forecast_status === 'ready' ? Math.ceil(row.forecast_next_week_raw) : null,
      needs_replenishment: row.forecast_status === 'ready' ? row.recommended_order_quantity > 0 : null,
    }))
    .filter(row => !normalizedSearch
      || `${row.item_code} ${row.item_name}`.toLocaleLowerCase('vi').includes(normalizedSearch))
    .sort((left, right) => right.recommended_order_quantity - left.recommended_order_quantity
      || left.item_name.localeCompare(right.item_name, 'vi'));
}

router.get('/', async (req, res) => {
  try {
    const warehouseId = req.query.warehouse_id
      ? requirePositiveId(req.query.warehouse_id, 'Kho')
      : null;
    const serviceLevel = req.query.service_level === undefined
      ? 0.95
      : Number(req.query.service_level);
    if (![0.90, 0.95].includes(serviceLevel)) {
      return res.status(400).json({ success: false, message: 'Mức phục vụ chỉ hỗ trợ 0.90 hoặc 0.95' });
    }

    const today = todayKey();
    const liveWeekStart = mondayOfWeek(today);
    const requestedWeek = req.query.week_start;
    if (requestedWeek !== undefined && (typeof requestedWeek !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(requestedWeek)
      || dateKey(requestedWeek) !== requestedWeek
      || mondayOfWeek(requestedWeek) !== requestedWeek || requestedWeek > liveWeekStart)) {
      return res.status(400).json({ success: false, message: 'Chọn tuần bắt đầu từ thứ Hai hợp lệ, không sau tuần hiện tại' });
    }
    const currentWeekStart = requestedWeek || liveWeekStart;
    const historical = currentWeekStart < liveWeekStart;
    const currentWeekEnd = addDays(currentWeekStart, 6);
    const lastCompletedWeekStart = historical ? currentWeekStart : addDays(currentWeekStart, -7);
    const completedThroughDate = addDays(lastCompletedWeekStart, 6);
    const pool = await getPool();
    const [allWeeklyRows, currentStocks, registeredSeries] = await Promise.all([
      // Keep the week choices stable even when a selected warehouse has no tracked series.
      getWeeklyDemandSeries(pool, { activeOnly: true, completeOnly: false, toDate: addDays(liveWeekStart, -1) }),
      historical ? Promise.resolve(new Map()) : getCurrentStocks(pool, warehouseId, today),
      getDemandSeries(pool, { warehouseId, activeOnly: true, asOfDate: historical ? currentWeekEnd : today }),
    ]);
    // The selector includes gaps, but training and historical values never include future weeks.
    const availableWeeks = [];
    const firstWeek = allWeeklyRows.map(row => dateKey(row.week_start)).filter(week => week && mondayOfWeek(week) === week).sort()[0];
    for (let week = liveWeekStart; firstWeek && week >= firstWeek; week = addDays(week, -7)) {
      availableWeeks.push({ week_start: week, week_end: addDays(week, 6), is_current: week === liveWeekStart });
    }
    const weeklyRows = allWeeklyRows.filter(row => (!warehouseId || Number(row.warehouse_id) === warehouseId)
      && dateKey(row.week_end) <= completedThroughDate);
    const period = {
      current_week_start: currentWeekStart, current_week_end: currentWeekEnd,
      forecast_week_start: addDays(currentWeekStart, 7), forecast_week_end: addDays(currentWeekEnd, 7),
    };
    const view = { mode: historical ? 'historical_week_close' : 'current_live',
      as_of_date: historical ? currentWeekEnd : today, is_saved_snapshot: false };
    if (weeklyRows.length === 0 && registeredSeries.length === 0) {
      return res.json({
        data: [],
        kpis: {
          total_current_inventory: 0,
          total_safety_stock: 0,
          total_forecast_next_week: 0,
          materials_requiring_replenishment: 0,
          total_recommended_order_quantity: 0,
        },
        period, view, available_weeks: availableWeeks,
        close_through_date: addDays(liveWeekStart, -1),
        assumptions: { lead_time_days: 7, service_level: serviceLevel },
      });
    }

    const issuedByWeek = historical ? new Map() : await getWeeklyIssuedQuantities(
      pool,
      warehouseId,
      currentWeekStart,
      today,
    );
    const coverage = prepareForecastCoverage(weeklyRows, lastCompletedWeekStart, registeredSeries);
    // Live selection may learn from completed history; it never rewrites a past benchmark.
    const evaluation = coverage.ready_rows.length ? selectOperationalModels(coverage.ready_rows, {
      completedThroughDate,
    }) : null;
    const policyBySeries = Object.fromEntries((evaluation?.series || []).map(series => {
      if (historical) return [series.key, {}]; // Defaults: selected week's closing stock, issues and one-step forecast.
      const currentWeekUnitsSold = issuedByWeek.get(`${series.key}:${currentWeekStart}`) || 0;
      const currentWeekEstimate = Math.max(
        currentWeekUnitsSold,
        Number(series.evaluation.selected_next_forecast) || 0,
      );
      return [series.key, {
        onHand: currentStocks.get(series.key) || 0,
        currentWeekUnitsSold,
        forecast: forecastFollowingWeek(series, currentWeekEstimate),
      }];
    }));
    const recommendations = evaluation ? buildReplenishmentAnalysis(evaluation, {
      leadTimeDays: 7,
      serviceLevel,
      policyBySeries,
    }).recommendations : [];
    for (const group of coverage.series) {
      const ready = recommendations.find(row => row.key === group.key);
      if (ready) Object.assign(ready, group.coverage);
      else {
        const selectedRow = weeklyRows.find(row => `${Number(row.item_id)}:${Number(row.warehouse_id)}` === group.key
          && dateKey(row.week_start) === currentWeekStart && isCompleteDemandWeek(row));
        recommendations.push({ ...group.coverage,
        item_id: group.item_id, item_code: group.item_code, item_name: group.item_name,
        on_hand: historical ? (selectedRow?.closing_inventory == null ? null : Number(selectedRow.closing_inventory)) : currentStocks.get(group.key) || 0,
        current_week_units_sold: historical ? (selectedRow ? Number(selectedRow.units_sold) : null) : issuedByWeek.get(`${group.key}:${currentWeekStart}`) || 0,
        safety_stock: null, forecast_next_week: null,
        recommended_order_quantity: null, needs_replenishment: null,
        });
      }
    }
    // Historical receipt totals share the persisted weekly source of stock and issues.
    // Baseline history can predate the operational receipt ledger.
    const received = historical
      ? new Map(weeklyRows.filter(row => dateKey(row.week_start) === currentWeekStart && isCompleteDemandWeek(row))
        .map(row => [`${Number(row.item_id)}:${Number(row.warehouse_id)}`, Number(row.received_quantity) || 0]))
      : await getWeeklyReceivedQuantities(pool, warehouseId, currentWeekStart, today);
    for (const row of recommendations) row.current_week_received = received.get(`${row.item_id}:${row.warehouse_id}`) || 0;
    const data = aggregateRecommendations(recommendations, req.query.search);
    const allItemRows = aggregateRecommendations(recommendations, '');
    // Do not present a partial sum as the total for all selected warehouses/items.
    const completeTotal = value => allItemRows.every(row => row.forecast_status === 'ready')
      ? allItemRows.reduce((total, row) => total + value(row), 0) : null;

    res.json({
      data,
      kpis: {
        total_current_inventory: allItemRows.every(row => row.current_stock != null)
          ? allItemRows.reduce((total, row) => total + row.current_stock, 0) : null,
        total_safety_stock: completeTotal(row => row.safety_stock),
        total_forecast_next_week: completeTotal(row => row.forecast_next_week),
        materials_requiring_replenishment: completeTotal(row => row.needs_replenishment ? 1 : 0),
        total_recommended_order_quantity: completeTotal(row => row.recommended_order_quantity),
      },
      data_coverage: coverage.metadata,
      close_through_date: addDays(liveWeekStart, -1),
      period, view, available_weeks: availableWeeks,
      assumptions: {
        lead_time_days: 7,
        service_level: serviceLevel,
        on_order_default: 0,
        backorders_default: 0,
      },
      quality: {
        protocol_version: PROTOCOL_VERSION,
        series_count: coverage.series.length,
        selection_source: 'validation_walk_forward',
        metric_scope: 'live_validation',
        forecast_horizon: historical ? 'next_week_after_completed_selected_week' : 'current_week_estimate_then_next_week',
        evaluation_horizon_weeks: 1,
        deployment_counts: evaluation?.deployment_counts ?? {},
        validation_mae: evaluation?.selected_validation_metrics.mae ?? null,
        validation_metrics: evaluation?.selected_validation_metrics ?? null,
        live_selection: evaluation?.metadata ?? null,
        // Compatibility fields never substitute live Validation for independent Test.
        test_mae: null, selected_model_mae: null, test_metrics: null,
        benchmark: { available: false, computed: false, endpoint: '/api/forecast/benchmark',
          reason: 'Đánh giá hồi cứu được tách khỏi dự báo vận hành' },
        calibration_source: 'validation_walk_forward',
        calibration_samples_per_series: evaluation?.series[0].evaluation.validation_size ?? null,
      },
      filters: { warehouse_id: warehouseId, week_start: currentWeekStart, search: String(req.query.search || '') },
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.get('/items/:id/movements', async (req, res) => {
  try {
    const itemId = requirePositiveId(req.params.id, 'Vật tư');
    const warehouseId = req.query.warehouse_id ? requirePositiveId(req.query.warehouse_id, 'Kho') : null;
    res.json(await getRecentItemMovements(await getPool(), itemId, warehouseId, req.query.range || 'month', req.query.to_date));
  } catch (error) { res.status(error.status || 500).json({ success: false, message: error.message }); }
});

router.get('/benchmark', async (req, res) => {
  try {
    const warehouseId = req.query.warehouse_id ? requirePositiveId(req.query.warehouse_id, 'Kho') : null;
    const pool = await getPool();
    const rows = await getWeeklyDemandSeries(pool, { warehouseId, completeOnly: false, toDate: HISTORICAL_BENCHMARK.to_date });
    const benchmark = evaluateHistoricalBenchmark(rows.filter(row => row.is_training_eligible));
    res.json({ available: true, protocol_version: PROTOCOL_VERSION,
      series_count: benchmark.series_count, metadata: benchmark.metadata,
      aggregate_metrics: benchmark.aggregate_metrics, deployment_counts: benchmark.deployment_counts,
      selected_validation_metrics: benchmark.selected_validation_metrics,
      test_metrics: benchmark.deployment_portfolio_metrics,
      error_diagnostics: benchmark.error_diagnostics });
  } catch (error) {
    res.status(error.code === 'FORECAST_BENCHMARK_UNAVAILABLE' ? 422 : error.status || 500)
      .json({ success: false, available: false, message: error.message });
  }
});

// Explicit retirement notice for old callers; no duplicate replay implementation.
router.get('/history', (req, res) => res.status(410).json({ success: false,
  code: 'FORECAST_HISTORY_RETIRED', message: 'Dùng /api/forecast?week_start=YYYY-MM-DD để xem số liệu cuối tuần',
  replacement: '/api/forecast' }));

module.exports = router;
