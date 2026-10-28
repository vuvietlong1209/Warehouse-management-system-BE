const { sql } = require('./db');
const { getItemBinStock } = require('./inventory');
const { httpError } = require('./validation');
const { securityMoneySql } = require('./payment-accounting');
async function lockLedger(tx) {
  const r = await tx.request().query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=N'EWarehouse:stock-posting',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000; SELECT @r r");
  if (r.recordset[0].r < 0) throw httpError(409, 'Đang xử lý giao dịch khác, vui lòng thử lại');
}
async function reservedQuantity(tx,item,bin,except=null) {
  return Number((await tx.request().input('item',sql.Int,item).input('bin',sql.Int,bin).input('except',sql.Int,except).query(`SELECT ISNULL(SUM(d.reserved_quantity),0) n FROM goods_issue_details d JOIN goods_issues h ON h.id=d.goods_issue_id WHERE d.item_id=@item AND d.bin_id=@bin AND h.status=1 AND h.lifecycle_status='Active' AND h.activated_at IS NOT NULL AND (@except IS NULL OR h.id<>@except)`)).recordset[0].n);
}
async function rebalanceReservations(tx) {
  await tx.request().query("UPDATE d SET reserved_quantity=0 FROM goods_issue_details d JOIN goods_issues h ON h.id=d.goods_issue_id WHERE h.status=0 OR (h.lifecycle_status<>'Active' OR h.activated_at IS NULL)");
  const rows=(await tx.request().query(`SELECT d.*,ISNULL((SELECT SUM(x.quantity) FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE x.goods_issue_detail_id=d.id AND m.operation_status='Confirmed' AND m.operation_kind='ISSUE'),0) fulfilled
    FROM goods_issue_details d JOIN goods_issues h ON h.id=d.goods_issue_id JOIN items i ON i.id=d.item_id JOIN base_units u ON u.id=i.base_unit_id JOIN bins b ON b.id=d.bin_id JOIN warehouses w ON w.id=h.warehouse_id
    WHERE h.status=1 AND h.lifecycle_status='Active' AND h.activated_at IS NOT NULL AND i.status=1 AND u.status=1 AND b.status=1 AND w.status=1 ORDER BY h.activated_at,h.id,d.id`)).recordset;
  for(const d of rows){
    const stock=await getItemBinStock(tx,d.item_id,d.bin_id), all=await reservedQuantity(tx,d.item_id,d.bin_id);
    const available=Math.max(0,stock-all+Number(d.reserved_quantity));
    const needed=Math.max(0,Number(d.quantity_ordered)-Number(d.fulfilled));
    if(Math.min(Number(d.reserved_quantity),needed)>available+1e-8)throw httpError(409,'Giao dịch làm thiếu hàng đã giữ. Cần giải phóng phần giữ trước.');
    const quantity=Math.min(needed,available);
    await tx.request().input('id',sql.Int,d.id).input('qty',sql.Decimal(18,2),quantity).query('UPDATE goods_issue_details SET reserved_quantity=@qty WHERE id=@id');
  }
}
async function reconcileReservations(tx,lines,release=false,user=null) {
  const impact=[];
  for(const l of lines){
    const stock=await getItemBinStock(tx,l.item_id,l.bin_id);let excess=Math.max(0,await reservedQuantity(tx,l.item_id,l.bin_id)-stock);
    if(excess<1e-8)continue;impact.push({item_id:l.item_id,bin_id:l.bin_id,release_quantity:excess,on_hand:stock});
    if(release){
      const rows=(await tx.request().input('i',sql.Int,l.item_id).input('b',sql.Int,l.bin_id).query("SELECT d.id,d.reserved_quantity FROM goods_issue_details d JOIN goods_issues h ON h.id=d.goods_issue_id WHERE d.item_id=@i AND d.bin_id=@b AND h.status=1 AND h.lifecycle_status='Active' AND d.reserved_quantity>0 ORDER BY h.activated_at DESC,d.id DESC")).recordset;
      for(const d of rows){const used=Math.min(excess,Number(d.reserved_quantity));if(used<=0)break;await tx.request().input('id',sql.Int,d.id).input('q',sql.Decimal(18,2),used).query('UPDATE goods_issue_details SET reserved_quantity=reserved_quantity-@q WHERE id=@id');excess-=used;}
    }
  }
  if(impact.length&&!release){const e=httpError(409,'Kiểm kê làm thiếu hàng giữ. Xác nhận giải phóng phần thiếu hoặc điều chỉnh giữ hàng trước.');e.code='RESERVATION_RELEASE_REQUIRED';e.impact=impact;throw e;}
  return impact;
}
async function assertCatalogDocumentsSafe(tx,entity,id) {
  const column={item:'d.item_id',unit:'i.base_unit_id',bin:'d.bin_id',warehouse:'h.warehouse_id',partner:'h.partner_id',user:'h.user_id'}[entity];if(!column)return;
  for(const receipt of [true,false]){
    const t=receipt?'goods_receipts':'goods_issues',dt=receipt?'goods_receipt_details':'goods_issue_details',fk=receipt?'goods_receipt_id':'goods_issue_id',df=receipt?'goods_receipt_detail_id':'goods_issue_detail_id';
    const r=(await tx.request().input('id',sql.Int,id).query(`SELECT TOP 1 h.code FROM ${t} h JOIN ${dt} d ON d.${fk}=h.id JOIN items i ON i.id=d.item_id WHERE ${column}=@id AND h.status=1 AND h.lifecycle_status='Active' AND h.activated_at IS NOT NULL AND
      (d.quantity_ordered>ISNULL((SELECT SUM(${receipt?'x.paid_quantity':'x.quantity'}) FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE x.${df}=d.id AND m.operation_status='Confirmed' AND m.operation_kind='${receipt?'RECEIPT':'ISSUE'}'),0))`)).recordset;
    if(r.length)throw httpError(409,`Danh mục đang được đơn ${r[0].code} sử dụng. Xử lý phần chưa hoàn tất trước.`);
    if(['partner','warehouse','user'].includes(entity)){
      const open=(await tx.request().input('id',sql.Int,id).query(`SELECT TOP 1 h.code FROM ${t} h WHERE ${column.replace('d.','h.')}=@id AND h.status=1 AND h.lifecycle_status='Active' AND h.activated_at IS NOT NULL AND
        (EXISTS(SELECT 1 FROM payments p WHERE p.${fk}=h.id AND p.operation_status='Pending') OR
         ABS(ISNULL((SELECT SUM(d.quantity_ordered*d.unit_price) FROM ${dt} d WHERE d.${fk}=h.id),0)-ISNULL((SELECT SUM(CASE WHEN p.purpose='REFUND' THEN -p.amount ELSE p.amount END) FROM payments p LEFT JOIN payments o ON o.id=p.refund_of_id WHERE p.${fk}=h.id AND p.operation_status='Confirmed' AND NOT ${securityMoneySql()}),0))>0.005 OR
         ISNULL((SELECT SUM(CASE WHEN p.purpose='REFUND' THEN -p.amount ELSE p.amount END) FROM payments p LEFT JOIN payments o ON o.id=p.refund_of_id WHERE p.${fk}=h.id AND p.operation_status='Confirmed' AND ${securityMoneySql()}),0)>0)`)).recordset;
      if(open.length)throw httpError(409,`Đơn ${open[0].code} còn tiền chưa thanh toán. Hoàn tất xử lý trước khi ngừng danh mục.`);
    }
  }
}
module.exports={lockLedger,reservedQuantity,rebalanceReservations,reconcileReservations,assertCatalogDocumentsSafe};

async function reserveDocument(tx,id,user){
 const ops=require('./document-operations'),h=await ops.document(tx,'issue',id);ops.editable(h);await ops.validHeader(tx,h,user);
 if(h.lifecycle_status!=='Draft')throw httpError(409,'Đơn đã giữ chỗ hoặc không còn ở trạng thái Mới lập');
 if(h.items.some(d=>Number(d.pending_quantity)>Number(d.remaining_quantity)))throw httpError(409,'Lượng xuất đang chờ vượt yêu cầu. Chỉnh sửa lần xuất trước khi giữ chỗ.');
 for(const d of h.items){const v=await require('./inventory').validateItemAndBin(tx,d.item_id,d.bin_id,h.warehouse_id);if(!v.item_valid||!v.bin_valid)throw httpError(409,'Sản phẩm/vị trí đã ngừng hoạt động');}
 await require('./document-stock-limits').assertStockLimits(tx,'issue',h,h.items.map(d=>({item_id:d.item_id,bin_id:d.bin_id,quantity:d.remaining_quantity})),{plan:true});
 const collisions=(await tx.request().input('id',sql.Int,h.id).query("SELECT TOP 1 m.id FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id JOIN goods_issue_details d ON d.id=x.goods_issue_detail_id WHERE m.goods_issue_id=@id AND m.operation_status='Pending' GROUP BY m.id,d.item_id,d.bin_id HAVING COUNT(*)>1")).recordset;
 if(collisions.length)throw httpError(409,'Có dòng xuất chờ trùng vị trí theo đơn. Chỉnh sửa lần xuất để gộp dòng trước khi giữ chỗ.');
 await tx.request().input('id',sql.Int,h.id).query("UPDATE x SET bin_id=d.bin_id,updated_at=GETDATE() FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id JOIN goods_issue_details d ON d.id=x.goods_issue_detail_id WHERE m.goods_issue_id=@id AND m.operation_status='Pending'");
 await tx.request().input('id',sql.Int,h.id).query("UPDATE goods_issues SET lifecycle_status='Active',activated_at=GETDATE(),updated_at=GETDATE() WHERE id=@id");
 await rebalanceReservations(tx);
 const reserved=await ops.document(tx,'issue',h.id);if(reserved.items.some(d=>Number(d.reserved_quantity)+1e-8<Number(d.remaining_quantity)))throw httpError(409,'Không đủ hàng để giữ chỗ toàn bộ lượng còn phải xuất');
 return{success:true,reserved_quantity:reserved.reserved_quantity};
}
module.exports.reserveDocument=reserveDocument;
