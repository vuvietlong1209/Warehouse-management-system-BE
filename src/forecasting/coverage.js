const { DEFAULT_WMA_VALIDATION_SIZE } = require('./evaluation');

const WEEK_MS = 7 * 86400000;
const MIN_HISTORY_WEEKS = 10 + DEFAULT_WMA_VALIDATION_SIZE;

function dateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function isCompleteDemandWeek(row) {
  const start = dateKey(row.week_start);
  const day = new Date(start);
  return !!start && day.getUTCDay() === 1
    && dateKey(row.week_end) === dateKey(new Date(day.getTime() + 6 * 86400000))
    && (row.is_complete_week === true || row.is_complete_week === 1)
    && (row.is_training_eligible === true || row.is_training_eligible === 1)
    && Number(row.calendar_day_count) === 7
    && row.units_sold != null && row.units_sold !== ''
    && typeof row.units_sold !== 'boolean'
    && Number.isFinite(Number(row.units_sold)) && Number(row.units_sold) >= 0;
}

// Presence of a confirmed issue is NOT proof that a whole week has been observed.
// Only the persisted daily-history panel (imported or explicitly closed) can supply
// complete weeks, including genuine zero-demand weeks.
function prepareForecastCoverage(rows, expectedWeekStart, registeredSeries = []) {
  const expectedStart = new Date(expectedWeekStart);
  if (dateKey(expectedStart) !== expectedWeekStart || expectedStart.getUTCDay() !== 1) {
    throw new Error('Mốc tuần hoàn tất phải là thứ Hai hợp lệ');
  }
  const expectedEnd = dateKey(new Date(expectedStart.getTime() + 6 * 86400000));
  const groups = new Map();
  for (const identity of registeredSeries) {
    const key = `${Number(identity.item_id)}:${Number(identity.warehouse_id)}`;
    groups.set(key, { ...identity, key, weeks: new Map() });
  }
  for (const row of rows) {
    const start = dateKey(row.week_start);
    if (!start || start > expectedWeekStart) continue;
    const key = `${Number(row.item_id)}:${Number(row.warehouse_id)}`;
    if (!groups.has(key)) groups.set(key, { key, ...row, weeks: new Map() });
    const group = groups.get(key);
    if (group.weeks.has(start)) throw new Error('Lịch sử dự báo có tuần trùng');
    group.weeks.set(start, row);
  }

  const series = [...groups.values()].map(group => {
    const complete = [...group.weeks.entries()].filter(([, row]) => isCompleteDemandWeek(row))
      .sort(([left], [right]) => left.localeCompare(right));
    const last = complete.at(-1);
    const history = [];
    // Never concatenate across an unobserved/invalid week or fill the gap with 0.
    for (let index = complete.length - 1; index >= 0; index--) {
      if (history.length && new Date(history[0].week_start) - new Date(complete[index][0]) !== WEEK_MS) break;
      history.unshift(complete[index][1]);
    }
    const missing = last ? Math.round((expectedStart - new Date(last[0])) / WEEK_MS) : null;
    const ready = missing === 0 && history.length >= MIN_HISTORY_WEEKS;
    const { weeks, ...identity } = group;
    return { ...identity, rows: history, coverage: {
      key: group.key,
      item_id: Number(group.item_id), warehouse_id: Number(group.warehouse_id),
      forecast_status: ready ? 'ready' : missing === 0 ? 'insufficient_history' : 'unclosed_history',
      last_complete_week_end: last ? dateKey(last[1].week_end) : null,
      required_through_date: expectedEnd,
      missing_completed_weeks: missing,
      history_week_count: history.length,
      minimum_history_weeks: MIN_HISTORY_WEEKS,
    } };
  });
  const ready = series.filter(group => group.coverage.forecast_status === 'ready');
  const ends = series.map(group => group.coverage.last_complete_week_end).filter(Boolean).sort();
  return { series, ready_rows: ready.flatMap(group => group.rows), metadata: {
    source: 'persisted_complete_daily_history',
    missing_week_policy: 'unavailable_not_zero',
    series_count: series.length,
    ready_series_count: ready.length,
    unavailable_series_count: series.length - ready.length,
    required_through_date: expectedEnd,
    complete_through_date: series.length && ends.length === series.length ? ends[0] : null,
    minimum_history_weeks: MIN_HISTORY_WEEKS,
    series: series.map(group => group.coverage),
  } };
}

module.exports = { MIN_HISTORY_WEEKS, prepareForecastCoverage, isCompleteDemandWeek };
