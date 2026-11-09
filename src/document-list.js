const { sql } = require('./db');
const { requirePositiveId, requireDate, httpError } = require('./validation');
const ops = require('./document-operations');

async function listDocuments(pool, kind, query) {
  const c = ops.config(kind), paged = ['page','page_size','search','status','warehouse_id','partner_id','from_date','to_date'].some(k => query[k] !== undefined);
  const size = Math.min(100, Math.max(5, parseInt(query.page_size, 10) || 25));
  const requested = Math.max(1, parseInt(query.page, 10) || 1);
  const from = query.from_date ? requireDate(query.from_date, 'Từ ngày') : null;
  const to = query.to_date ? requireDate(query.to_date, 'Đến ngày') : null;
  if (from && to && from > to) throw httpError(400, 'Từ ngày không được sau đến ngày');
  const status = query.status || '';
  if (status && !(c.r ? ['Active','Completed','Cancelled'] : ['Draft','Active','Completed','Cancelled']).includes(status)) throw httpError(400, 'Trạng thái đơn không hợp lệ');
  const request = () => pool.request().input('search', sql.NVarChar(128), String(query.search || '').trim().slice(0, 128))
    .input('state', sql.VarChar(12), status).input('from', sql.Date, from).input('to', sql.Date, to)
    .input('warehouse', sql.Int, query.warehouse_id ? requirePositiveId(query.warehouse_id, 'Kho') : null)
    .input('partner', sql.Int, query.partner_id ? requirePositiveId(query.partner_id, 'Đối tác') : null);
  const where = `FROM ${c.table} h JOIN warehouses w ON w.id=h.warehouse_id JOIN partners p ON p.id=h.partner_id
    WHERE (h.status=1 OR h.lifecycle_status='Cancelled') AND (@state='' OR h.lifecycle_status=@state)
      AND (@warehouse IS NULL OR h.warehouse_id=@warehouse) AND (@partner IS NULL OR h.partner_id=@partner)
      AND (@from IS NULL OR h.order_date>=@from) AND (@to IS NULL OR h.order_date<=@to)
      AND (@search='' OR CHARINDEX(
        TRANSLATE(@search,N'đĐ',N'dD') COLLATE Latin1_General_100_CI_AI,
        TRANSLATE(CONCAT(h.code,N' ',p.name,N' ',w.name),N'đĐ',N'dD') COLLATE Latin1_General_100_CI_AI)>0)`;
  const total = (await request().query(`SELECT COUNT(*) total ${where}`)).recordset[0].total;
  const pages = Math.ceil(total / size), page = Math.min(requested, Math.max(1, pages));
  const ids = (await request().input('offset', sql.Int, (page - 1) * size).input('size', sql.Int, size)
    .query(`SELECT h.id ${where} ORDER BY h.id DESC ${paged ? 'OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY' : ''}`)).recordset;
  const data = [];
  // Hydrate only this page; child collections are needed by existing callers.
  for (const row of ids) data.push(await ops.document(pool, kind, row.id));
  return paged ? { data, pagination: { page, page_size: size, total, total_pages: pages } } : data;
}
module.exports = { listDocuments };
