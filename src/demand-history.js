const { sql } = require('./db');
const { httpError, requireDate, sqlDateKey } = require('./validation');
const { todayKey } = require('./business-date');
const { BASELINE_HISTORY_END_DATE, demandSeriesCtes } = require('./demand-series');

const MAX_REBUILD_DAYS = 366;

function dateKey(value) {
  return value instanceof Date ? sqlDateKey(value) : requireDate(value);
}

function toUtcDate(value) {
  return new Date(`${dateKey(value)}T00:00:00.000Z`);
}

function addDays(value, amount) {
  const date = toUtcDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function inclusiveDayCount(fromDate, toDate) {
  return Math.round((toUtcDate(toDate) - toUtcDate(fromDate)) / 86400000) + 1;
}

async function getHistoryBoundaries(executor) {
  const result = await executor.request()
    .input('baseline_end', sql.Date, BASELINE_HISTORY_END_DATE)
    .query(`SELECT CONVERT(varchar(10), @baseline_end,23) AS baseline_end,
      CONVERT(varchar(10),MAX(CASE WHEN demand_date>@baseline_end THEN demand_date END),23) AS closed_end
      FROM dbo.daily_demand_history;`);
  return result.recordset[0] || { baseline_end: null, closed_end: null };
}

async function mergeOperationalDay(executor, demandDate, options = {}) {
  const result = await executor.request()
    .input('baseline_end', sql.Date, BASELINE_HISTORY_END_DATE)
    .input('demand_date', sql.Date, demandDate)
    .input('allow_insert', sql.Bit, options.allowInsert !== false)
    .input('update_existing', sql.Bit, options.updateExisting !== false)
    .query(`
      ;WITH ${demandSeriesCtes('@demand_date')}, received AS (
        SELECT poi.item_id, po.warehouse_id, SUM(poi.quantity_ordered) AS quantity
        FROM dbo.receipt_transaction_details poi
        INNER JOIN dbo.receipt_transactions po ON po.id=poi.goods_receipt_id
        WHERE po.status=1 AND po.receipt_status=N'Confirmed' AND po.order_date=@demand_date
        GROUP BY poi.item_id, po.warehouse_id
      ), sold AS (
        SELECT soi.item_id, so.warehouse_id, SUM(soi.quantity_ordered) AS quantity
        FROM dbo.issue_transaction_details soi
        INNER JOIN dbo.issue_transactions so ON so.id=soi.goods_issue_id
        WHERE so.status=1 AND so.issue_status=N'Confirmed' AND so.order_date=@demand_date
        GROUP BY soi.item_id, so.warehouse_id
      ), adjusted AS (
        SELECT icd.item_id, ic.warehouse_id, SUM(icd.discrepancy) AS quantity
        FROM dbo.inventory_check_details icd
        INNER JOIN dbo.inventory_checks ic ON ic.id=icd.inventory_check_id
        WHERE ic.status=1 AND ic.check_status=N'Completed' AND icd.discrepancy_handled=1
          AND ic.to_date=@demand_date
        GROUP BY icd.item_id, ic.warehouse_id
      ), source_rows AS (
        SELECT @demand_date AS demand_date, 
               CAST(
                 ISNULL((SELECT SUM(poi.quantity_ordered)
                         FROM dbo.receipt_transaction_details poi
                         INNER JOIN dbo.receipt_transactions po ON po.id=poi.goods_receipt_id
                         WHERE poi.item_id=p.item_id AND po.warehouse_id=p.warehouse_id
                           AND po.status=1 AND po.receipt_status=N'Confirmed'
                           AND po.order_date<@demand_date), 0)
                 - ISNULL((SELECT SUM(soi.quantity_ordered)
                           FROM dbo.issue_transaction_details soi
                           INNER JOIN dbo.issue_transactions so ON so.id=soi.goods_issue_id
                           WHERE soi.item_id=p.item_id AND so.warehouse_id=p.warehouse_id
                             AND so.status=1 AND so.issue_status=N'Confirmed'
                             AND so.order_date<@demand_date), 0)
                 + ISNULL((SELECT SUM(icd.discrepancy)
                           FROM dbo.inventory_check_details icd
                           INNER JOIN dbo.inventory_checks ic ON ic.id=icd.inventory_check_id
                           WHERE icd.item_id=p.item_id AND ic.warehouse_id=p.warehouse_id
                             AND ic.status=1 AND ic.check_status=N'Completed'
                             AND icd.discrepancy_handled=1 AND ic.to_date<@demand_date), 0)
                 AS DECIMAL(18,4)) AS opening_inventory,
               CAST(ISNULL(s.quantity, 0) AS DECIMAL(18,4)) AS units_sold,
               CAST(ISNULL(r.quantity, 0) AS DECIMAL(18,4)) AS received_quantity,
               CAST(ISNULL(a.quantity, 0) AS DECIMAL(18,4)) AS adjustment_quantity,
               p.item_id, p.warehouse_id
        FROM tracked_pairs p
        LEFT JOIN received r ON r.item_id=p.item_id AND r.warehouse_id=p.warehouse_id
        LEFT JOIN sold s ON s.item_id=p.item_id AND s.warehouse_id=p.warehouse_id
        LEFT JOIN adjusted a ON a.item_id=p.item_id AND a.warehouse_id=p.warehouse_id
      ), balanced_rows AS (
        SELECT *, CAST(opening_inventory + received_quantity + adjustment_quantity - units_sold AS DECIMAL(18,4)) AS closing_inventory
        FROM source_rows
      )
      SELECT * INTO #operational_demand_rows FROM balanced_rows;

      IF EXISTS (SELECT 1 FROM #operational_demand_rows WHERE opening_inventory<0 OR closing_inventory<0)
        THROW 50001, N'Dữ liệu nghiệp vụ tạo tồn kho âm; không thể đồng bộ lịch sử nhu cầu.', 1;

      MERGE dbo.daily_demand_history WITH (HOLDLOCK) AS target
      USING #operational_demand_rows AS source
        ON target.demand_date=source.demand_date
       AND target.item_id=source.item_id
       AND target.warehouse_id=source.warehouse_id
      WHEN MATCHED AND target.demand_date>@baseline_end AND @update_existing=1 THEN
        UPDATE SET opening_inventory=source.opening_inventory,
                   units_sold=source.units_sold,
                   received_quantity=source.received_quantity,
                   adjustment_quantity=source.adjustment_quantity,
                   closing_inventory=source.closing_inventory
      WHEN NOT MATCHED AND @allow_insert=1 THEN
        INSERT (demand_date, opening_inventory, units_sold,
                received_quantity, adjustment_quantity, closing_inventory, item_id, warehouse_id)
        VALUES (source.demand_date,
                source.opening_inventory, source.units_sold, source.received_quantity,
                source.adjustment_quantity, source.closing_inventory, source.item_id, source.warehouse_id)
      OUTPUT $action AS action;

      DROP TABLE #operational_demand_rows;
    `);
  return result.recordset.reduce((summary, row) => {
    const key = String(row.action || '').toLowerCase();
    if (key === 'insert') summary.inserted += 1;
    if (key === 'update') summary.updated += 1;
    return summary;
  }, { inserted: 0, updated: 0 });
}

async function rebuildOperationalHistory(executor, fromValue, toValue, createdBy, options = {}) {
  const fromDate = dateKey(fromValue);
  const toDate = dateKey(toValue);
  if (fromDate > toDate) throw httpError(400, 'Từ ngày không được lớn hơn đến ngày');
  const dayCount = inclusiveDayCount(fromDate, toDate);
  if (dayCount > (options.maxDays || MAX_REBUILD_DAYS)) {
    throw httpError(400, `Mỗi lần chỉ được đồng bộ tối đa ${options.maxDays || MAX_REBUILD_DAYS} ngày`);
  }

  const boundaries = options.boundaries || await getHistoryBoundaries(executor);
  if (boundaries.baseline_end && fromDate <= boundaries.baseline_end) {
    throw httpError(409, `Dữ liệu nền đến ${boundaries.baseline_end} được khóa bảo vệ; chỉ được đồng bộ từ ngày kế tiếp`);
  }

  const totals = { inserted: 0, updated: 0 };
  for (let cursor = fromDate; cursor <= toDate; cursor = addDays(cursor, 1)) {
    const dayResult = await mergeOperationalDay(executor, cursor);
    totals.inserted += dayResult.inserted;
    totals.updated += dayResult.updated;
  }
  return { from_date: fromDate, to_date: toDate, day_count: dayCount, ...totals };
}

async function runSerializable(pool, work) {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await work(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    try { await transaction.rollback(); } catch (_) {}
    throw error;
  }
}

async function closeOperationalHistoryThrough(pool, targetValue, createdBy) {
  const targetDate = dateKey(targetValue);
  if (targetDate > todayKey()) throw httpError(400, 'Không thể chốt lịch sử cho ngày trong tương lai');
  const boundaries = await getHistoryBoundaries(pool);
  if (boundaries.baseline_end && targetDate <= boundaries.baseline_end) {
    throw httpError(409, 'Ngày chốt phải sau dữ liệu lịch sử nền');
  }
  const result = await pool.request()
    .input('series_date', sql.Date, targetDate)
    .input('baseline_end', sql.Date, boundaries.baseline_end)
    .query(`WITH ${demandSeriesCtes()}, start_date AS (
      SELECT MIN(CASE WHEN @baseline_end IS NOT NULL AND tracking_start_date<=@baseline_end
        THEN DATEADD(day,1,@baseline_end) ELSE tracking_start_date END) first_date FROM tracked_pairs
    ), dates AS (
      SELECT first_date demand_date FROM start_date WHERE first_date<=@series_date
      UNION ALL SELECT DATEADD(day,1,demand_date) FROM dates WHERE demand_date<@series_date
    )
    SELECT CONVERT(varchar(10),d.demand_date,23) demand_date FROM dates d
    WHERE EXISTS (SELECT 1 FROM tracked_pairs p WHERE p.tracking_start_date<=d.demand_date
      AND NOT EXISTS(SELECT 1 FROM dbo.daily_demand_history h
        WHERE h.item_id=p.item_id AND h.warehouse_id=p.warehouse_id AND h.demand_date=d.demand_date))
    ORDER BY d.demand_date OPTION(MAXRECURSION 0);`);
  const days = result.recordset.map(row => row.demand_date);
  const totals = { inserted: 0, updated: 0, day_count: 0, chunks_completed: 0 };
  // Missing days only; each bounded batch is atomic, including all its pairs.
  // Retrying after an interrupted later batch discovers only the remaining gaps.
  try {
    for (let offset = 0; offset < days.length; offset += MAX_REBUILD_DAYS) {
      const chunk = days.slice(offset, offset + MAX_REBUILD_DAYS);
      const completed = await runSerializable(pool, async transaction => {
        let inserted = 0;
        for (const day of chunk) {
          inserted += (await mergeOperationalDay(transaction, day, { updateExisting: false })).inserted;
        }
        return { inserted };
      });
      totals.inserted += completed.inserted;
      totals.day_count += chunk.length; totals.chunks_completed++;
    }
  } catch (error) {
    if (totals.chunks_completed) {
      error.message += ` Đã hoàn tất ${totals.day_count} ngày ở các đợt trước; chạy lại để tiếp tục phần còn thiếu.`;
    }
    throw error;
  }
  return { from_date: days[0] || null, to_date: targetDate, ...totals };
}

async function runOperationalHistoryRebuild(pool, fromDate, toDate, createdBy) {
  const normalizedTo = dateKey(toDate);
  if (normalizedTo > todayKey()) throw httpError(400, 'Không thể tái tạo lịch sử cho ngày trong tương lai');
  return runSerializable(pool, transaction => rebuildOperationalHistory(
    transaction,
    fromDate,
    normalizedTo,
    createdBy,
  ));
}

async function syncOperationalHistoryAfterDocument(transaction, options) {
  const demandDate = dateKey(options.date);
  if (demandDate > todayKey()) return { skipped: true, reason: 'future_document' };
  const itemIds = [...new Set((options.itemIds || []).map(Number).filter(Number.isInteger))];
  if (!itemIds.length) return { skipped: true, reason: 'no_items' };
  const warehouseId = Number(options.warehouseId);
  const inList = itemIds.join(',');
  const tracked = await transaction.request()
    .input('warehouse_id', sql.Int, warehouseId)
    .input('series_date', sql.Date, demandDate)
    .query(`
      WITH ${demandSeriesCtes()}
      SELECT TOP 1 1 AS tracked
      FROM tracked_pairs
      WHERE warehouse_id=@warehouse_id AND item_id IN (${inList});
    `);
  if (!tracked.recordset.length) return { skipped: true, reason: 'untracked_series' };

  const boundaries = await getHistoryBoundaries(transaction);
  if (boundaries.baseline_end && demandDate <= boundaries.baseline_end) {
    return { skipped: true, reason: 'protected_baseline_history' };
  }
  // A single approval does not certify all other items/days have been entered.
  // Refresh only an already closed period; extending it requires close-day/rebuild.
  if (!boundaries.closed_end || demandDate > boundaries.closed_end) {
    return { skipped: true, reason: 'unclosed_history' };
  }
  const closed = await transaction.request()
    .input('baseline_end', sql.Date, BASELINE_HISTORY_END_DATE)
    .input('from_date', sql.Date, demandDate)
    .query(`
      SELECT DISTINCT h.demand_date
      FROM dbo.daily_demand_history h
      WHERE h.demand_date>@baseline_end AND h.demand_date>=@from_date
      ORDER BY h.demand_date;
    `);
  if (!closed.recordset.length) return { skipped: true, reason: 'unclosed_history' };
  const totals = { inserted: 0, updated: 0 };
  for (const row of closed.recordset) {
    const result = await mergeOperationalDay(transaction, dateKey(row.demand_date), { allowInsert: false });
    totals.updated += result.updated;
  }
  return { from_date: demandDate, to_date: boundaries.closed_end,
    day_count: closed.recordset.length, ...totals };
}

module.exports = {
  closeOperationalHistoryThrough,
  getHistoryBoundaries,
  rebuildOperationalHistory,
  runOperationalHistoryRebuild,
  syncOperationalHistoryAfterDocument,
};
