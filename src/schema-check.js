// Validate the current schema without upgrading or rewriting operational data.
async function checkSchema(executor) {
  const result = await executor.request().query(`
    SELECT name FROM (VALUES
      ('dbo.roles'),('dbo.users'),('dbo.partners'),('dbo.base_units'),('dbo.warehouses'),
      ('dbo.bins'),('dbo.items'),('dbo.goods_receipts'),('dbo.goods_receipt_details'),
      ('dbo.goods_issues'),('dbo.goods_issue_details'),('dbo.inventory_checks'),
      ('dbo.inventory_check_details'),('dbo.stock_movements'),('dbo.stock_movement_details'),
      ('dbo.payments'),('dbo.daily_demand_history'),
      ('dbo.receipt_transactions'),('dbo.receipt_transaction_details'),
      ('dbo.issue_transactions'),('dbo.issue_transaction_details'),('dbo.weekly_demand_history')
    ) required(name) WHERE OBJECT_ID(name) IS NULL;
    SELECT COL_LENGTH('dbo.items','forecast_enabled') forecast_flag,
      COL_LENGTH('dbo.goods_receipts','revision_no') revision_no,
      COL_LENGTH('dbo.goods_issues','lifecycle_status') lifecycle_status,
      COL_LENGTH('dbo.stock_movement_details','cost_price') posted_cost,
      COL_LENGTH('dbo.stock_movements','source_document_id') ledger_order,
      COL_LENGTH('dbo.stock_movement_details','source_detail_id') ledger_line,
      COL_LENGTH('dbo.payments','security_action') security_action;
    SELECT COUNT(*) retired_columns FROM sys.columns WHERE
      (object_id IN (OBJECT_ID('dbo.goods_receipts'),OBJECT_ID('dbo.goods_issues')) AND name IN ('receipt_status','issue_status','confirmed_at','rejected_at')) OR
      (object_id=OBJECT_ID('dbo.goods_receipt_details') AND name IN ('weighted_average_code','paid_quantity','bonus_quantity','commercial_unit_price','inventory_value','cancelled_quantity')) OR
      (object_id=OBJECT_ID('dbo.goods_issue_details') AND name IN ('weighted_average_code','cost_price','auto_calculate_cost','cancelled_quantity')) OR
      (object_id=OBJECT_ID('dbo.stock_movement_details') AND name IN ('costing_code','auto_calculate_cost')) OR
      (object_id=OBJECT_ID('dbo.daily_demand_history') AND name IN ('source_product_code','source_store_code'));
    SELECT OBJECT_ID('dbo.report_history') retired_report_table;
  `);
  if (result.recordsets[0].length || Object.values(result.recordsets[1][0]).some(v => v === null)
    || result.recordsets[2][0].retired_columns || result.recordsets[3][0].retired_report_table !== null) {
    throw new Error('Database chưa đúng schema hiện tại. Tạo môi trường mới bằng database/schema.sql hoặc khôi phục backup tương thích. Không tự nâng cấp dữ liệu.');
  }
  return { success: true };
}
module.exports = { checkSchema };
