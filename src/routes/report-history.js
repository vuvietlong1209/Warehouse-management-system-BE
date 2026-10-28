const router = require('express').Router();
const { getPool, sql } = require('../db');
const { httpError, requirePositiveId } = require('../validation');
const { validateCreation, validateHistoryFilters, escapeLike, names } = require('../report-history');

const columns = `id,report_type,report_name,output_format,paper_size,from_date,to_date,
  warehouse_id,warehouse_name,search_term,creator_id,creator_name,creator_username,created_at,row_count`;
const fail = (res, error) => res.status(error.status || 500).json({ success: false, message: error.message });

router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.post('/', async (req, res) => {
  try {
    const { snapshot, criteria, creationKey, warehouseId } = validateCreation(req.body);
    const pool = await getPool();
    const request = pool.request()
      .input('creation_key', sql.UniqueIdentifier, creationKey)
      .input('report_type', sql.VarChar(16), snapshot.reportType)
      .input('report_name', sql.NVarChar(160), names[snapshot.reportType])
      .input('format', sql.VarChar(8), criteria.format)
      .input('paper_size', sql.VarChar(2), snapshot.paperSize)
      .input('from_date', sql.Date, snapshot.fromDate).input('to_date', sql.Date, snapshot.toDate)
      .input('warehouse_id', sql.Int, warehouseId).input('warehouse_name', sql.NVarChar(256), snapshot.warehouseName)
      .input('search', sql.NVarChar(128), snapshot.search)
      .input('creator_id', sql.Int, req.user.id).input('creator_name', sql.NVarChar(160), req.user.name || req.user.username)
      .input('creator_username', sql.NVarChar(100), req.user.username)
      .input('row_count', sql.Int, snapshot.rows.length)
      .input('criteria', sql.NVarChar(sql.MAX), JSON.stringify(criteria))
      .input('snapshot', sql.NVarChar(sql.MAX), JSON.stringify(snapshot));
    try {
      const result = await request.query(`INSERT INTO dbo.report_history
        (creation_key,report_type,report_name,output_format,paper_size,from_date,to_date,warehouse_id,warehouse_name,
         search_term,creator_id,creator_name,creator_username,row_count,criteria_json,snapshot_json)
        OUTPUT ${columns.split(',').map(column => `INSERTED.${column.trim()}`).join(',')}
        VALUES (@creation_key,@report_type,@report_name,@format,@paper_size,@from_date,@to_date,@warehouse_id,
          @warehouse_name,@search,@creator_id,@creator_name,@creator_username,@row_count,@criteria,@snapshot)`);
      res.status(201).json(result.recordset[0]);
    } catch (error) {
      if (![2601, 2627].includes(error.number)) throw error;
      // Retrying an interrupted request must not create duplicate history entries.
      const existing = await pool.request().input('key', sql.UniqueIdentifier, creationKey)
        .query(`SELECT ${columns},criteria_json,snapshot_json FROM dbo.report_history WHERE creation_key=@key`);
      const row = existing.recordset[0];
      if (!row || row.creator_id !== req.user.id || row.criteria_json !== JSON.stringify(criteria)
        || row.snapshot_json !== JSON.stringify(snapshot)) throw httpError(409, 'Mã lần tạo đã được sử dụng cho báo cáo khác');
      delete row.criteria_json; delete row.snapshot_json;
      res.json(row);
    }
  } catch (error) { fail(res, error); }
});

router.get('/', async (req, res) => {
  try {
    const selected = validateHistoryFilters(req.query);
    const pool = await getPool();
    const result = await pool.request()
      .input('type', sql.VarChar(16), selected.reportType).input('format', sql.VarChar(8), selected.format)
      .input('creator_id', sql.Int, selected.creatorId)
      .input('from_date', sql.Date, selected.fromDate).input('to_date', sql.Date, selected.toDate)
      .input('search', sql.NVarChar(260), `%${escapeLike(selected.search)}%`)
      .input('offset', sql.Int, (selected.page - 1) * selected.pageSize).input('limit', sql.Int, selected.pageSize)
      .query(`DECLARE @matched TABLE(id INT PRIMARY KEY);
        INSERT INTO @matched SELECT id FROM dbo.report_history
        WHERE report_type IN ('NXT','PO','SO','KK','STOCK')
          AND (@type='' OR report_type=@type) AND (@format='' OR output_format=@format)
          AND (@creator_id IS NULL OR creator_id=@creator_id)
          -- Date filters follow the same Vietnamese timezone as the visible creation date.
          AND (@from_date IS NULL OR created_at >= DATEADD(HOUR,-7,CAST(@from_date AS DATETIME2)))
          AND (@to_date IS NULL OR created_at < DATEADD(HOUR,17,CAST(@to_date AS DATETIME2)))
          AND (report_name LIKE @search ESCAPE '~' OR creator_name LIKE @search ESCAPE '~'
            OR creator_username LIKE @search ESCAPE '~' OR warehouse_name LIKE @search ESCAPE '~'
            OR search_term LIKE @search ESCAPE '~');
        SELECT ${columns} FROM dbo.report_history WHERE id IN (SELECT id FROM @matched)
          ORDER BY created_at DESC,id DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        SELECT COUNT(*) AS total FROM @matched;
        WITH authors AS (SELECT creator_id,creator_name,creator_username,
          ROW_NUMBER() OVER(PARTITION BY creator_id ORDER BY created_at DESC,id DESC) AS rn FROM dbo.report_history)
        SELECT creator_id AS id,creator_name AS name,creator_username AS username FROM authors WHERE rn=1 ORDER BY creator_name;`);
    const total = result.recordsets[1][0].total;
    res.json({ data: result.recordsets[0], creators: result.recordsets[2],
      pagination: { page: selected.page, page_size: selected.pageSize, total, total_pages: Math.ceil(total / selected.pageSize) } });
  } catch (error) { fail(res, error); }
});

router.get('/:id', async (req, res) => {
  try {
    const id = requirePositiveId(req.params.id, 'Báo cáo');
    if (id > 2147483647) throw httpError(400, 'Báo cáo không hợp lệ');
    const pool = await getPool();
    const result = await pool.request().input('id', sql.Int, id)
      .query(`SELECT ${columns},criteria_json,snapshot_json FROM dbo.report_history WHERE id=@id`);
    const row = result.recordset[0];
    if (!row) throw httpError(404, 'Không tìm thấy báo cáo đã tạo');
    const { criteria_json, snapshot_json, ...record } = row;
    res.json({ ...record, criteria: JSON.parse(criteria_json), snapshot: JSON.parse(snapshot_json) });
  } catch (error) { fail(res, error); }
});

module.exports = router;
