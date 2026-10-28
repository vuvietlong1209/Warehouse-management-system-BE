const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { getIdleStock } = require('../idle-stock');

router.get('/idle-stock', async (req, res) => {
  try { res.json(await getIdleStock(await getPool(), req.query)); }
  catch (error) { res.status(error.status || 500).json({ success: false, message: error.message }); }
});

// GET /api/dashboard - Thống kê tổng quan cho trang Dashboard
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();

    // Tổng nhập kho (số lượng)
    const importQtyResult = await pool.request().query(`
      SELECT ISNULL(SUM(poi.quantity_ordered), 0) AS total
      FROM receipt_transaction_details poi
      JOIN receipt_transactions po ON poi.goods_receipt_id = po.id
      WHERE po.receipt_status = 'Confirmed' AND po.status = 1
    `);

    // Tổng xuất kho (số lượng)
    const exportQtyResult = await pool.request().query(`
      SELECT ISNULL(SUM(soi.quantity_ordered), 0) AS total
      FROM issue_transaction_details soi
      JOIN issue_transactions so ON soi.goods_issue_id = so.id
      WHERE so.issue_status = 'Confirmed' AND so.status = 1
    `);

    // Giá trị hàng nhập, không suy ra thu/chi thực tế.
    const moneyOutResult = await pool.request().query(`
      SELECT ISNULL(SUM(COALESCE(poi.inventory_value,poi.quantity_ordered * poi.unit_price)), 0) AS total
      FROM receipt_transaction_details poi
      JOIN receipt_transactions po ON poi.goods_receipt_id = po.id
      WHERE po.receipt_status = 'Confirmed' AND po.status = 1
    `);

    // Giá trị hàng xuất; giao dịch tiền được báo cáo từ payments.
    const moneyInResult = await pool.request().query(`
      SELECT ISNULL(SUM(soi.quantity_ordered * soi.unit_price), 0) AS total
      FROM issue_transaction_details soi
      JOIN issue_transactions so ON soi.goods_issue_id = so.id
      WHERE so.issue_status = 'Confirmed' AND so.status = 1
    `);

    // Top 5 sản phẩm xuất nhiều nhất
    const topExportResult = await pool.request().query(`
      SELECT TOP 5 i.name, SUM(soi.quantity_ordered) AS value
      FROM issue_transaction_details soi
      JOIN issue_transactions so ON soi.goods_issue_id = so.id
      JOIN items i ON soi.item_id = i.id
      WHERE so.issue_status = 'Confirmed' AND so.status = 1
      GROUP BY i.id, i.name
      ORDER BY value DESC
    `);

    // Revenue is the value of confirmed issues, independent of payment progress.
    const topRevenueResult = await pool.request().query(`
      SELECT TOP 5 i.code,i.name,SUM(d.quantity_ordered*d.unit_price) AS value
      FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id
      JOIN items i ON i.id=d.item_id
      WHERE h.issue_status='Confirmed' AND h.status=1
      GROUP BY i.id,i.code,i.name HAVING SUM(d.quantity_ordered*d.unit_price)>0
      ORDER BY value DESC,i.code
    `);

    res.json({
      totalImportQty: importQtyResult.recordset[0].total,
      totalExportQty: exportQtyResult.recordset[0].total,
      totalMoneyOut: moneyOutResult.recordset[0].total,
      totalMoneyIn: moneyInResult.recordset[0].total,
      topMostExported: topExportResult.recordset,
      topRevenueProducts: topRevenueResult.recordset,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
