const { sql } = require('./db');
const { loadValuationData } = require('./valuation-data');
const { valueItemStock, valuationEvents, money } = require('./stock-valuation');

const EPSILON = 1e-8;
const eventKey = event => `${event.type}:${event.line_id}`;
const dateLabel = date => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
function conflict(message) {
  const error = new Error(`Không thể chốt chứng từ: ${message}`);
  error.status = 409;
  return error;
}
const documentLabel = event => `${event.document_code || `${event.type}-${event.order_id}`} (${dateLabel(event.date)})`;
const expectedCost = (event, state) => state.average_cost;

function observeItem(history, item, visit) {
  const select = rows => rows.filter(row => row.item_id === item.id);
  return valueItemStock(item, select(history.receipts), select(history.issues), select(history.adjustments),
    '1900-01-01', { beforeMovement: visit });
}

// Pure simulation: approved values are replayed, never rewritten. Compare the
// incremental effect against the original ledger, not an unrelated old defect.
function assertStockPostingSafe(before, after, { itemIds, binIds, bins }) {
  const affectedItems = new Set(itemIds);
  for (const item of after.items.filter(row => affectedItems.has(row.id))) {
    const original = new Map();
    observeItem(before, item, (event, state) => original.set(eventKey(event), state));
    observeItem(after, item, (event, state) => {
      const withdrawn = event.type === 'OUT' ? Number(event.quantity_ordered)
        : event.type === 'ADJUSTMENT' ? -Number(event.adjustment) : 0;
      if (withdrawn > state.bin_quantity + EPSILON) {
        throw conflict(`${documentLabel(event)} làm âm tồn ${item.code} tại Bin ${event.bin_id}: `
          + `còn ${state.bin_quantity}, cần ${withdrawn}.`);
      }
      const old = original.get(eventKey(event));
      if (event.type === 'OUT') {
        const expected = money(expectedCost(event, state));
        if (old && expected !== money(expectedCost(event, old))) {
          throw conflict(`làm thay đổi giá vốn đã chốt của phiếu ${documentLabel(event)}, sản phẩm ${item.code} `
            + `(${money(expectedCost(event, old))} → ${expected}).`);
        }
        if (!old && expected !== money(Number(event.cost_price))) {
          throw conflict(`giá vốn của ${documentLabel(event)}, sản phẩm ${item.code} không khớp thứ tự giao dịch trong ngày. `
            + 'Vui lòng kiểm tra ngày chứng từ.');
        }
      }
      if (event.type === 'ADJUSTMENT') {
        // A new count must also match the exact position it occupies in the
        // timeline, rather than accidentally using a later same-day snapshot.
        const book = old ? old.bin_quantity : Number(event.book_quantity);
        if (Math.abs(state.bin_quantity - book) > EPSILON) {
          throw conflict(`làm lệch tồn sổ sách của phiếu kiểm kê ${documentLabel(event)}, sản phẩm ${item.code} `
            + `(${book} → ${state.bin_quantity}).`);
        }
        if (old && money(Number(event.adjustment) * old.average_cost)
          !== money(Number(event.adjustment) * state.average_cost)) {
          throw conflict(`làm thay đổi giá trị điều chỉnh của phiếu kiểm kê ${documentLabel(event)}, sản phẩm ${item.code}.`);
        }
      }
    });
  }
  assertHistoricalCapacity(before, after, binIds, bins);
}

function assertHistoricalCapacity(before, after, binIds, bins) {
  const affected = new Set(binIds);
  const limits = new Map(bins.map(bin => [bin.id, bin]));
  const oldKeys = new Set(valuationEvents(before.receipts, before.issues, before.adjustments).map(eventKey));
  const events = valuationEvents(after.receipts, after.issues, after.adjustments);
  const oldStock = new Map();
  const newStock = new Map();
  // All detail lines of a document are one atomic posting, especially a count
  // with both positive and negative differences sharing the same bin.
  for (let index = 0; index < events.length;) {
    const first = events[index];
    const group = `${first.type}:${first.order_id}`;
    const touched = new Set();
    do {
      const event = events[index++];
      if (!affected.has(event.bin_id)) continue;
      touched.add(event.bin_id);
      const delta = event.type === 'IN' ? Number(event.quantity_ordered)
        : event.type === 'OUT' ? -Number(event.quantity_ordered) : Number(event.adjustment);
      newStock.set(event.bin_id, (newStock.get(event.bin_id) || 0) + delta);
      if (oldKeys.has(eventKey(event))) oldStock.set(event.bin_id, (oldStock.get(event.bin_id) || 0) + delta);
    } while (index < events.length && `${events[index].type}:${events[index].order_id}` === group);
    for (const binId of touched) {
      const bin = limits.get(binId);
      if (!bin) throw conflict(`không tìm thấy sức chứa Bin ${binId}.`);
      const current = newStock.get(binId) || 0;
      if (current > Number(bin.max_capacity) + EPSILON && current > (oldStock.get(binId) || 0) + EPSILON) {
        throw conflict(`vượt sức chứa BIN-${bin.location_id} tại ${documentLabel(first)}: `
          + `${current}/${bin.max_capacity} đơn vị.`);
      }
    }
  }
}

// Acquire the ledger lock before any data locks. SERIALIZABLE history reads
// can scan common tables even for different warehouses; a per-warehouse lock
// alone allows conversion deadlocks. Transaction ownership releases this lock
// automatically on commit/rollback, also across multiple backend processes.
async function lockPostingWarehouse(transaction, table, id) {
  if (!['goods_receipts', 'goods_issues', 'inventory_checks'].includes(table)) throw new Error('Invalid posting table');
  const lock = await transaction.request().query(`
    DECLARE @result int;
    EXEC @result=sys.sp_getapplock @Resource=N'EWarehouse:stock-posting',
      @LockMode='Exclusive', @LockOwner='Transaction', @LockTimeout=10000;
    SELECT @result lock_result;`);
  if (Number(lock.recordset[0].lock_result) < 0) {
    throw conflict('đang có phiên chốt sổ khác, vui lòng thử lại sau.');
  }
  const found = await transaction.request().input('id', sql.Int, id).query(`
    SELECT warehouse_id FROM ${table} WITH (READCOMMITTEDLOCK) WHERE id=@id AND status=1`);
  const warehouseId = found.recordset[0]?.warehouse_id;
  if (warehouseId != null) await transaction.request().input('warehouse', sql.Int, warehouseId).query(`
    SELECT id FROM warehouses WITH (UPDLOCK, HOLDLOCK) WHERE id=@warehouse`);
  return warehouseId;
}

async function captureStockPosting(transaction, warehouseId, lines) {
  const before = await loadValuationData(transaction, { warehouseId });
  const bins = (await transaction.request().input('warehouse', sql.Int, warehouseId).query(`
    SELECT id,location_id,max_capacity FROM bins WITH (UPDLOCK, HOLDLOCK) WHERE warehouse_id=@warehouse`)).recordset;
  return { before, warehouseId, bins, itemIds: lines.map(row => row.item_id), binIds: lines.map(row => row.bin_id) };
}

async function validateStockPosting(transaction, snapshot) {
  const after = await loadValuationData(transaction, { warehouseId: snapshot.warehouseId });
  assertStockPostingSafe(snapshot.before, after, snapshot);
}

module.exports = { assertStockPostingSafe, lockPostingWarehouse, captureStockPosting, validateStockPosting };
