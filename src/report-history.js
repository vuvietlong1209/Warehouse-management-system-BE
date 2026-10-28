const { validateSnapshot } = require('./report-renderer');
const { requireDate, requirePositiveId, httpError } = require('./validation');

const types = ['NXT', 'PO', 'SO', 'KK', 'STOCK'];
const formats = ['EXCEL', 'WORD', 'PDF'];
const names = { NXT: 'Nhập - Xuất - Tồn', PO: 'Bảng kê phiếu nhập kho',
  SO: 'Bảng kê phiếu xuất kho', KK: 'Bảng kê phiếu kiểm kê', STOCK: 'Tồn kho' };

function text(value, maximum = 128) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    throw httpError(400, 'Từ khóa tìm kiếm không hợp lệ hoặc quá dài');
  }
  return value.trim();
}

function validateCreation(body) {
  const snapshot = validateSnapshot(body?.snapshot);
  const criteria = body?.criteria;
  if (!criteria || !formats.includes(criteria.format)) throw httpError(400, 'Định dạng báo cáo không hợp lệ');
  for (const field of ['reportType', 'fromDate', 'toDate', 'paperSize']) {
    if (criteria[field] !== snapshot[field]) throw httpError(400, 'Tham số không khớp với báo cáo đã tạo');
  }
  const search = text(criteria.search || '');
  if (search !== snapshot.search) throw httpError(400, 'Từ khóa không khớp với báo cáo đã tạo');
  const warehouseId = criteria.warehouseId === '' ? null : requirePositiveId(criteria.warehouseId, 'Kho hàng');
  if (warehouseId > 2147483647) throw httpError(400, 'Kho hàng không hợp lệ');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.creationKey || '')) {
    throw httpError(400, 'Mã lần tạo báo cáo không hợp lệ');
  }
  return { creationKey: body.creationKey, snapshot, warehouseId,
    criteria: { reportType: snapshot.reportType, format: criteria.format, fromDate: snapshot.fromDate,
      toDate: snapshot.toDate, warehouseId: warehouseId === null ? '' : String(warehouseId), search, paperSize: snapshot.paperSize } };
}

function validateHistoryFilters(query) {
  const reportType = query.report_type || '';
  const format = query.format || '';
  if (reportType && !types.includes(reportType)) throw httpError(400, 'Mẫu báo cáo không hợp lệ');
  if (format && !formats.includes(format)) throw httpError(400, 'Định dạng báo cáo không hợp lệ');
  const fromDate = query.from_date ? requireDate(query.from_date, 'Ngày tạo từ') : null;
  const toDate = query.to_date ? requireDate(query.to_date, 'Ngày tạo đến') : null;
  if (fromDate && toDate && fromDate > toDate) throw httpError(400, 'Ngày tạo từ không được lớn hơn ngày tạo đến');
  const page = Number(query.page || 1), pageSize = Number(query.page_size || 10);
  if (!Number.isInteger(page) || page < 1 || page > 1000000 || ![10, 25, 50].includes(pageSize)) throw httpError(400, 'Phân trang không hợp lệ');
  const creatorId = query.creator_id ? requirePositiveId(query.creator_id, 'Người tạo') : null;
  if (creatorId > 2147483647) throw httpError(400, 'Người tạo không hợp lệ');
  return { reportType, format, fromDate, toDate, creatorId, page, pageSize, search: text(query.search || '') };
}

// Treat %, _, [ as literal search characters, never SQL LIKE wildcards.
function escapeLike(value) { return value.replace(/[~%_\[]/g, character => `~${character}`); }

module.exports = { validateCreation, validateHistoryFilters, escapeLike, names };
