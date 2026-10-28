const express = require('express');
const router = express.Router();
const { getPool } = require('../db');

// GET /api/bootstrap - Lấy toàn bộ dữ liệu khởi động hệ thống trong 1 round-trip
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();

    // Thực thi song song tất cả các truy vấn danh mục & chứng từ
    const [
      itemsRes,
      binsRes,
      warehousesRes,
      partnersRes,
      usersRes,
      rolesRes,
      unitsRes,
      posRes,
      sosRes,
      icsRes,
    ] = await Promise.all([
      // 1. Items
      pool.request().query(`
        SELECT i.id, i.code, i.name, i.base_unit_id, i.status,
               i.created_at, i.updated_at,
               bu.code AS base_unit_name,
               (SELECT d.bin_id,SUM(d.reserved_quantity) quantity FROM goods_issue_details d JOIN goods_issues o ON o.id=d.goods_issue_id WHERE d.item_id=i.id AND o.lifecycle_status='Active' AND o.status=1 AND d.reserved_quantity>0 GROUP BY d.bin_id FOR JSON PATH) reserved_bins,
               ISNULL((
                 SELECT SUM(poi.quantity_ordered)
                 FROM receipt_transaction_details poi
                 JOIN receipt_transactions po ON poi.goods_receipt_id = po.id
                 WHERE poi.item_id = i.id AND po.receipt_status = 'Confirmed' AND po.status = 1
               ), 0)
               - ISNULL((
                 SELECT SUM(soi.quantity_ordered)
                 FROM issue_transaction_details soi
                 JOIN issue_transactions so ON soi.goods_issue_id = so.id
                 WHERE soi.item_id = i.id AND so.issue_status = 'Confirmed' AND so.status = 1
               ), 0)
               + ISNULL((
                 SELECT SUM(icd.discrepancy)
                 FROM inventory_check_details icd
                 JOIN inventory_checks ic ON icd.inventory_check_id = ic.id
                 WHERE icd.item_id = i.id AND ic.check_status = 'Completed'
                   AND ic.status = 1 AND icd.discrepancy_handled = 1
               ), 0) AS stock_quantity
        FROM items i
        LEFT JOIN base_units bu ON i.base_unit_id = bu.id
        WHERE i.status = 1
        ORDER BY i.id ASC
      `),

      // 2. Bins
      pool.request().query(`
        SELECT b.id, b.location_id, b.warehouse_id, b.description, b.max_capacity, b.status,
               b.created_at, b.updated_at, w.name AS warehouse_name
        FROM bins b
        LEFT JOIN warehouses w ON b.warehouse_id = w.id
        WHERE b.status = 1
        ORDER BY b.id ASC
      `),

      // 3. Warehouses
      pool.request().query(`
        SELECT id, code, name, status, created_at, updated_at
        FROM warehouses
        WHERE status = 1
        ORDER BY id ASC
      `),

      // 4. Partners
      pool.request().query(`
        SELECT id, code, name, phone_number, address, status, created_at, updated_at
        FROM partners
        WHERE status = 1
        ORDER BY id ASC
      `),

      // 5. Users
      pool.request().query(`
        SELECT u.id, u.username, u.email, u.name, u.role_id, u.status, u.created_at, u.updated_at,
               r.role_name
        FROM users u
        LEFT JOIN roles r ON u.role_id = r.id
        WHERE u.status = 1
        ORDER BY u.id ASC
      `),

      // 6. Roles
      pool.request().query(`
        SELECT id, code, role_name, status, created_at, updated_at
        FROM roles
        WHERE status = 1
        ORDER BY id ASC
      `),

      // 7. Base Units
      pool.request().query(`
        SELECT id, code, description, status, created_at, updated_at
        FROM base_units
        WHERE status = 1
        ORDER BY id ASC
      `),

      // 8. Goods Receipts
      pool.request().query(`
        SELECT po.id, po.code, po.order_date, po.warehouse_id, po.partner_id, po.user_id,
               po.description, po.receipt_status, po.root_id,
               po.status, po.created_at, po.updated_at, po.confirmed_at, po.rejected_at,
               w.name AS warehouse_name, p.name AS partner_name, u.name AS user_name
        FROM receipt_transactions po
        LEFT JOIN warehouses w ON po.warehouse_id = w.id
        LEFT JOIN partners p ON po.partner_id = p.id
        LEFT JOIN users u ON po.user_id = u.id
        WHERE po.status = 1
        ORDER BY po.id DESC
      `),

      // 9. Goods Issues
      pool.request().query(`
        SELECT so.id, so.code, so.order_date, so.warehouse_id, so.partner_id, so.user_id,
               so.description, so.issue_status, so.root_id,
               so.status, so.created_at, so.updated_at, so.confirmed_at, so.rejected_at,
               w.name AS warehouse_name, p.name AS partner_name, u.name AS user_name
        FROM issue_transactions so
        LEFT JOIN warehouses w ON so.warehouse_id = w.id
        LEFT JOIN partners p ON so.partner_id = p.id
        LEFT JOIN users u ON so.user_id = u.id
        WHERE so.status = 1
        ORDER BY so.id DESC
      `),

      // 10. Inventory Checks
      pool.request().query(`
        SELECT ic.id, ic.code, ic.from_date, ic.to_date, ic.warehouse_id, ic.user_id,
               ic.description, ic.check_status, ic.status, ic.created_at, ic.updated_at,
               w.name AS warehouse_name, u.name AS user_name
        FROM inventory_checks ic
        LEFT JOIN warehouses w ON ic.warehouse_id = w.id
        LEFT JOIN users u ON ic.user_id = u.id
        WHERE ic.status = 1
        ORDER BY ic.id DESC
      `),
    ]);

    const pos = posRes.recordset;
    const sos = sosRes.recordset;
    const ics = icsRes.recordset;

    // Lấy chi tiết items cho POs, SOs và ICs nếu có dữ liệu
    const receiptIds = pos.map(p => p.id);
    const issueIds = sos.map(s => s.id);
    const icIds = ics.map(i => i.id);

    const [poItemsRes, soItemsRes, icDetailsRes] = await Promise.all([
      receiptIds.length > 0
        ? pool.request().query(`
            SELECT poi.id, poi.goods_receipt_id, poi.item_id, poi.quantity_ordered,
                   poi.unit_price, poi.bin_id, poi.inventory_value, poi.paid_quantity, poi.bonus_quantity, poi.commercial_unit_price,
                   poi.created_at, poi.updated_at,
                   i.code AS item_code, i.name AS item_name,
                   b.description AS bin_description
            FROM receipt_transaction_details poi
            LEFT JOIN items i ON poi.item_id = i.id
            LEFT JOIN bins b ON poi.bin_id = b.id
            WHERE poi.goods_receipt_id IN (${receiptIds.join(',')})
          `)
        : { recordset: [] },

      issueIds.length > 0
        ? pool.request().query(`
            SELECT soi.id, soi.goods_issue_id, soi.item_id, soi.quantity_ordered,
                   soi.unit_price, soi.cost_price, soi.bin_id,
                   soi.created_at, soi.updated_at,
                   i.code AS item_code, i.name AS item_name, b.description AS bin_description
            FROM issue_transaction_details soi
            LEFT JOIN items i ON soi.item_id = i.id
            LEFT JOIN bins b ON soi.bin_id = b.id
            WHERE soi.goods_issue_id IN (${issueIds.join(',')})
          `)
        : { recordset: [] },

      icIds.length > 0
        ? pool.request().query(`
            SELECT icd.id, icd.inventory_check_id, icd.check_detail_code, icd.item_id, icd.bin_id,
                   icd.actual_quantity, icd.book_quantity, icd.discrepancy, icd.discrepancy_handled,
                   icd.created_at, icd.updated_at,
                   i.code AS item_code, i.name AS item_name, b.description AS bin_description
            FROM inventory_check_details icd
            LEFT JOIN items i ON icd.item_id = i.id
            LEFT JOIN bins b ON icd.bin_id = b.id
            WHERE icd.inventory_check_id IN (${icIds.join(',')})
          `)
        : { recordset: [] },
    ]);

    // Map items vào từng chứng từ
    const poItemsMap = {};
    poItemsRes.recordset.forEach(item => {
      if (!poItemsMap[item.goods_receipt_id]) poItemsMap[item.goods_receipt_id] = [];
      poItemsMap[item.goods_receipt_id].push(item);
    });

    const soItemsMap = {};
    soItemsRes.recordset.forEach(item => {
      if (!soItemsMap[item.goods_issue_id]) soItemsMap[item.goods_issue_id] = [];
      soItemsMap[item.goods_issue_id].push(item);
    });

    const icDetailsMap = {};
    icDetailsRes.recordset.forEach(detail => {
      if (!icDetailsMap[detail.inventory_check_id]) icDetailsMap[detail.inventory_check_id] = [];
      icDetailsMap[detail.inventory_check_id].push(detail);
    });

    res.json({
      items: itemsRes.recordset,
      bins: binsRes.recordset,
      warehouses: warehousesRes.recordset,
      partners: partnersRes.recordset,
      users: usersRes.recordset,
      roles: rolesRes.recordset,
      units: unitsRes.recordset,
      goodsReceipts: pos.map(po => ({ ...po, items: poItemsMap[po.id] || [] })),
      goodsIssues: sos.map(so => ({ ...so, items: soItemsMap[so.id] || [] })),
      inventoryChecks: ics.map(ic => ({ ...ic, details: icDetailsMap[ic.id] || [] })),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Lỗi khi tải bootstrap data:', err);
    res.status(500).json({ error: 'Lỗi khi tải dữ liệu khởi động', message: err.message });
  }
});

module.exports = router;
