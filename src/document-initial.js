const crypto = require('node:crypto');
const { sql } = require('./db');
const ops = require('./document-operations');
const { createPayment, confirmPayment } = require('./document-payments');
const { httpError } = require('./validation');

// One transaction owns the root, its first stock movement and its first payment.
async function createInitial(tx, kind, body, user) {
  const c = ops.config(kind), request = ops.key(body.request_key);
  const fingerprint = ops.hash(['initial', kind, body]);
  const existing = (await tx.request().input('key', sql.UniqueIdentifier, request)
    .query(`SELECT id,request_hash FROM ${c.table} WHERE request_key=@key`)).recordset[0];
  if (existing) {
    if (existing.request_hash !== fingerprint) throw httpError(409, 'Yêu cầu đã được lưu với nội dung khác');
    return { success: true, id: existing.id, duplicate: true };
  }
  if (typeof body.approve_initial !== 'boolean') throw httpError(400, 'Chọn lưu hoặc lưu và duyệt');
  const payment = body.initial_payment || {};
  const amount = ops.amount(payment.amount || 0, 'Số tiền thanh toán');
  const physical = Array.isArray(body.items) && body.items.some(d => Number(d.first_quantity || 0) + Number(c.r ? d.first_bonus || 0 : 0) > 0);
  if (!physical && !amount) throw httpError(400, 'Nhập lượng thực hiện hoặc số tiền thanh toán lần đầu');
  const method = String(body.costing_method || 'AVERAGE').toUpperCase();
  if (!['AVERAGE'].includes(method)) throw httpError(400, 'Phương pháp giá vốn không hợp lệ');
  const id = await ops.saveDocument(tx, kind, body, user, null, { requestHash: fingerprint });
  const h = await ops.document(tx, kind, id);
  if(kind==='issue'&&body.reserve_stock===true)await require('./document-reservations').reserveDocument(tx,id,user);
  const movement = h.movements.find(m => m.operation_kind === c.op);
  if (body.approve_initial && movement) await ops.confirmMovement(tx, movement.id, user, method);
  let paymentId = null;
  if (amount) {
    if (!['PAYMENT', 'ADVANCE', 'SECURITY'].includes(payment.purpose || 'PAYMENT')) throw httpError(400, 'Loại thanh toán lần đầu không hợp lệ');
    paymentId = await createPayment(tx, kind, id, { ...payment, amount, request_key: crypto.randomUUID() }, user);
    if (body.approve_initial) await confirmPayment(tx, paymentId, user, { security_action: payment.security_action });
  }
  return { success: true, id, [c.r ? 'receiptId' : 'issueId']: id, movement_id: movement?.id || null, payment_id: paymentId };
}
module.exports = { createInitial };
