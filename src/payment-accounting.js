const { money } = require('./stock-valuation');

// These attributes belong to the linked order and payment purpose, not a second stored copy.
function withPaymentContext(payment, partnerId) {
  const receipt = payment.goods_receipt_id != null;
  const direction = payment.purpose === 'REFUND' ? (receipt ? 'IN' : 'OUT') : (receipt ? 'OUT' : 'IN');
  return { ...payment, partner_id: partnerId, direction };
}

// APPLY changes how the original cash receipt/payment settles the order; it is not new cash.
function isSecurityPayment(payment) {
  return payment.purpose === 'SECURITY' && payment.security_action !== 'APPLY'
    || payment.purpose === 'REFUND' && payment.refund_of_purpose === 'SECURITY' && payment.refund_of_security_action !== 'APPLY';
}
function paymentBalances(payments) {
  const confirmed = payments.filter(payment => payment.operation_status === 'Confirmed');
  const net = security => money(confirmed.filter(payment => isSecurityPayment(payment) === security)
    .reduce((sum, payment) => sum + (payment.purpose === 'REFUND' ? -1 : 1) * Number(payment.amount), 0));
  return { settled_amount: net(false), security_balance: net(true) };
}
const securityMoneySql = (payment = 'p', original = 'o') => `(
  (${payment}.purpose='SECURITY' AND ISNULL(${payment}.security_action,'KEEP')<>'APPLY') OR
  (${payment}.purpose='REFUND' AND ${original}.purpose='SECURITY' AND ISNULL(${original}.security_action,'KEEP')<>'APPLY'))`;
module.exports = { isSecurityPayment, paymentBalances, securityMoneySql, withPaymentContext };
