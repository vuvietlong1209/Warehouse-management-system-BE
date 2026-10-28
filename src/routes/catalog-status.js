const express = require('express');
const router = express.Router();
const { sql } = require('../db');
const { runSerializable } = require('../transaction');
const { requirePositiveId } = require('../validation');
const { lockLedger, assertCatalogDocumentsSafe } = require('../document-reservations');

const catalog = {
  item: { table: 'items', label: 'Vật tư' },
  bin: { table: 'bins', label: 'Vị trí lưu kho' },
  warehouse: { table: 'warehouses', label: 'Kho hàng' },
  partner: { table: 'partners', label: 'Đối tác' },
  user: { table: 'users', label: 'Nhân viên' },
  unit: { table: 'base_units', label: 'Đơn vị tính' },
};

function entityConfig(entity) {
  const config = catalog[entity];
  if (!config) {
    const error = new Error('Loại danh mục không hợp lệ');
    error.status = 400;
    throw error;
  }
  return config;
}

async function getImpact(executor, entity, id, lock = false) {
  const config = entityConfig(entity);
  const lockHint = lock ? ' WITH (UPDLOCK, HOLDLOCK)' : '';
  const current = await executor.request().input('id', sql.Int, id)
    .query(`SELECT id, status FROM ${config.table}${lockHint} WHERE id=@id`);
  if (!current.recordset.length) {
    const error = new Error(`Không tìm thấy ${config.label.toLocaleLowerCase('vi-VN')}`);
    error.status = 404;
    throw error;
  }

  let result;
  if (entity === 'item') {
    result = await executor.request().input('id', sql.Int, id).query(`
      SELECT i.code, i.name,
        ISNULL((SELECT SUM(d.quantity_ordered) FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id WHERE d.item_id=i.id AND h.status=1 AND h.receipt_status='Confirmed'),0)
        - ISNULL((SELECT SUM(d.quantity_ordered) FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id WHERE d.item_id=i.id AND h.status=1 AND h.issue_status='Confirmed'),0)
        + ISNULL((SELECT SUM(d.discrepancy) FROM inventory_check_details d JOIN inventory_checks h ON h.id=d.inventory_check_id WHERE d.item_id=i.id AND h.status=1 AND h.check_status='Completed' AND d.discrepancy_handled=1),0) stock,
        (SELECT COUNT(*) FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id WHERE d.item_id=i.id AND h.status=1 AND h.receipt_status='Pending')
        + (SELECT COUNT(*) FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id WHERE d.item_id=i.id AND h.status=1 AND h.issue_status='Pending')
        + (SELECT COUNT(*) FROM inventory_check_details d JOIN inventory_checks h ON h.id=d.inventory_check_id WHERE d.item_id=i.id AND h.status=1 AND h.check_status='InProgress') pending_documents,
        CAST(0 AS int) dependent_records, CAST(0 AS int) cascaded_records
      FROM items i WHERE i.id=@id
    `);
  } else if (entity === 'bin') {
    result = await executor.request().input('id', sql.Int, id).query(`
      SELECT CONCAT('BIN-', b.location_id) code, b.description name,
        ISNULL((SELECT SUM(d.quantity_ordered) FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id WHERE d.bin_id=b.id AND h.status=1 AND h.receipt_status='Confirmed'),0)
        - ISNULL((SELECT SUM(d.quantity_ordered) FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id WHERE d.bin_id=b.id AND h.status=1 AND h.issue_status='Confirmed'),0)
        + ISNULL((SELECT SUM(d.discrepancy) FROM inventory_check_details d JOIN inventory_checks h ON h.id=d.inventory_check_id WHERE d.bin_id=b.id AND h.status=1 AND h.check_status='Completed' AND d.discrepancy_handled=1),0) stock,
        (SELECT COUNT(*) FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id WHERE d.bin_id=b.id AND h.status=1 AND h.receipt_status='Pending')
        + (SELECT COUNT(*) FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id WHERE d.bin_id=b.id AND h.status=1 AND h.issue_status='Pending')
        + (SELECT COUNT(*) FROM inventory_check_details d JOIN inventory_checks h ON h.id=d.inventory_check_id WHERE d.bin_id=b.id AND h.status=1 AND h.check_status='InProgress') pending_documents,
        CAST(0 AS int) dependent_records, CAST(0 AS int) cascaded_records
      FROM bins b WHERE b.id=@id
    `);
  } else if (entity === 'warehouse') {
    result = await executor.request().input('id', sql.Int, id).query(`
      SELECT w.code, w.name,
        ISNULL((SELECT SUM(d.quantity_ordered) FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id WHERE h.warehouse_id=w.id AND h.status=1 AND h.receipt_status='Confirmed'),0)
        - ISNULL((SELECT SUM(d.quantity_ordered) FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id WHERE h.warehouse_id=w.id AND h.status=1 AND h.issue_status='Confirmed'),0)
        + ISNULL((SELECT SUM(d.discrepancy) FROM inventory_check_details d JOIN inventory_checks h ON h.id=d.inventory_check_id WHERE h.warehouse_id=w.id AND h.status=1 AND h.check_status='Completed' AND d.discrepancy_handled=1),0) stock,
        (SELECT COUNT(*) FROM receipt_transactions h WHERE h.warehouse_id=w.id AND h.status=1 AND h.receipt_status='Pending')
        + (SELECT COUNT(*) FROM issue_transactions h WHERE h.warehouse_id=w.id AND h.status=1 AND h.issue_status='Pending')
        + (SELECT COUNT(*) FROM inventory_checks h WHERE h.warehouse_id=w.id AND h.status=1 AND h.check_status='InProgress') pending_documents,
        CAST(0 AS int) dependent_records,
        (SELECT COUNT(*) FROM bins b WHERE b.warehouse_id=w.id AND b.status=1) cascaded_records
      FROM warehouses w WHERE w.id=@id
    `);
  } else if (entity === 'partner') {
    result = await executor.request().input('id', sql.Int, id).query(`
      SELECT p.code, p.name, CAST(0 AS decimal(18,2)) stock,
        (SELECT COUNT(*) FROM receipt_transactions h WHERE h.partner_id=p.id AND h.status=1 AND h.receipt_status='Pending')
        + (SELECT COUNT(*) FROM issue_transactions h WHERE h.partner_id=p.id AND h.status=1 AND h.issue_status='Pending') pending_documents,
        CAST(0 AS int) dependent_records, CAST(0 AS int) cascaded_records
      FROM partners p WHERE p.id=@id
    `);
  } else if (entity === 'user') {
    result = await executor.request().input('id', sql.Int, id).query(`
      SELECT u.username code, u.name, CAST(0 AS decimal(18,2)) stock,
        (SELECT COUNT(*) FROM receipt_transactions h WHERE h.user_id=u.id AND h.status=1 AND h.receipt_status='Pending')
        + (SELECT COUNT(*) FROM issue_transactions h WHERE h.user_id=u.id AND h.status=1 AND h.issue_status='Pending')
        + (SELECT COUNT(*) FROM inventory_checks h WHERE h.user_id=u.id AND h.status=1 AND h.check_status='InProgress') pending_documents,
        CAST(0 AS int) dependent_records, CAST(0 AS int) cascaded_records
      FROM users u WHERE u.id=@id
    `);
  } else {
    result = await executor.request().input('id', sql.Int, id).query(`
      SELECT bu.code, bu.description name,
        ISNULL((SELECT SUM(d.quantity_ordered) FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id JOIN items i ON i.id=d.item_id WHERE i.base_unit_id=bu.id AND h.status=1 AND h.receipt_status='Confirmed'),0)
        - ISNULL((SELECT SUM(d.quantity_ordered) FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id JOIN items i ON i.id=d.item_id WHERE i.base_unit_id=bu.id AND h.status=1 AND h.issue_status='Confirmed'),0)
        + ISNULL((SELECT SUM(d.discrepancy) FROM inventory_check_details d JOIN inventory_checks h ON h.id=d.inventory_check_id JOIN items i ON i.id=d.item_id WHERE i.base_unit_id=bu.id AND h.status=1 AND h.check_status='Completed' AND d.discrepancy_handled=1),0) stock,
        (SELECT COUNT(*) FROM receipt_transaction_details d JOIN receipt_transactions h ON h.id=d.goods_receipt_id JOIN items i ON i.id=d.item_id WHERE i.base_unit_id=bu.id AND h.status=1 AND h.receipt_status='Pending')
        + (SELECT COUNT(*) FROM issue_transaction_details d JOIN issue_transactions h ON h.id=d.goods_issue_id JOIN items i ON i.id=d.item_id WHERE i.base_unit_id=bu.id AND h.status=1 AND h.issue_status='Pending')
        + (SELECT COUNT(*) FROM inventory_check_details d JOIN inventory_checks h ON h.id=d.inventory_check_id JOIN items i ON i.id=d.item_id WHERE i.base_unit_id=bu.id AND h.status=1 AND h.check_status='InProgress') pending_documents,
        (SELECT COUNT(*) FROM items i WHERE i.base_unit_id=bu.id AND i.status=1) dependent_records,
        CAST(0 AS int) cascaded_records
      FROM base_units bu WHERE bu.id=@id
    `);
  }

  const row = result.recordset[0];
  const impact = {
    entity,
    id,
    label: config.label,
    code: row.code || '',
    name: row.name || '',
    current_status: Boolean(current.recordset[0].status),
    stock: Number(row.stock) || 0,
    pending_documents: Number(row.pending_documents) || 0,
    dependent_records: Number(row.dependent_records) || 0,
    cascaded_records: Number(row.cascaded_records) || 0,
  };
  impact.requires_confirmation = impact.stock !== 0
    || impact.pending_documents > 0
    || impact.dependent_records > 0
    || impact.cascaded_records > 0;
  return impact;
}

router.get('/:entity/:id/impact', async (req, res) => {
  try {
    const id = requirePositiveId(req.params.id, 'Danh mục');
    const impact = await runSerializable(transaction => getImpact(transaction, req.params.entity, id));
    res.json(impact);
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.patch('/:entity/:id', async (req, res) => {
  try {
    const id = requirePositiveId(req.params.id, 'Danh mục');
    const config = entityConfig(req.params.entity);
    if (typeof req.body.status !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Trạng thái danh mục không hợp lệ' });
    }
    if (req.params.entity === 'user' && id === req.user.id && req.body.status === false) {
      return res.status(409).json({ success: false, message: 'Không thể tự vô hiệu hóa tài khoản đang đăng nhập' });
    }

    const outcome = await runSerializable(async transaction => {
      await lockLedger(transaction);
      const impact = await getImpact(transaction, req.params.entity, id, true);
      if (impact.current_status === req.body.status) return { impact, unchanged: true };
      if (req.body.status === false) await assertCatalogDocumentsSafe(transaction, req.params.entity, id);
      if (req.body.status === false && impact.requires_confirmation && req.body.confirmed !== true) {
        return { impact, confirmationRequired: true };
      }

      if (req.body.status === true && req.params.entity === 'bin') {
        const parent = await transaction.request().input('id', sql.Int, id).query(`
          SELECT w.status FROM bins b JOIN warehouses w ON w.id=b.warehouse_id WHERE b.id=@id
        `);
        if (!parent.recordset.length || !parent.recordset[0].status) {
          const error = new Error('Không thể kích hoạt vị trí khi kho trực thuộc đang ngừng hoạt động');
          error.status = 409;
          throw error;
        }
      }
      if (req.body.status === true && req.params.entity === 'item') {
        const unit = await transaction.request().input('id', sql.Int, id).query(`
          SELECT bu.status FROM items i JOIN base_units bu ON bu.id=i.base_unit_id WHERE i.id=@id
        `);
        if (!unit.recordset.length || !unit.recordset[0].status) {
          const error = new Error('Không thể kích hoạt vật tư khi đơn vị tính đang ngừng áp dụng');
          error.status = 409;
          throw error;
        }
      }

      await transaction.request()
        .input('id', sql.Int, id)
        .input('status', sql.Bit, req.body.status ? 1 : 0)
        .query(`UPDATE ${config.table} SET status=@status, updated_at=GETDATE() WHERE id=@id`);
      if (req.params.entity === 'warehouse' && req.body.status === false) {
        await transaction.request().input('id', sql.Int, id).query(`
          UPDATE bins SET status=0, updated_at=GETDATE() WHERE warehouse_id=@id AND status=1
        `);
      }
      return { impact, unchanged: false };
    });

    if (outcome.confirmationRequired) {
      return res.status(409).json({
        success: false,
        code: 'DEACTIVATION_CONFIRMATION_REQUIRED',
        message: 'Danh mục đang còn dữ liệu liên quan. Cần xác nhận trước khi dừng hoạt động.',
        impact: outcome.impact,
      });
    }
    res.json({
      success: true,
      message: req.body.status ? 'Đã kích hoạt lại danh mục' : 'Đã dừng hoạt động danh mục',
      impact: outcome.impact,
      cascade: req.params.entity === 'warehouse' && req.body.status === false
        ? { deactivated_bins: outcome.impact.cascaded_records }
        : undefined,
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

module.exports = router;

