const {sql}=require('./db');
const ops=require('./document-operations');
const {httpError,requireDate,requirePositiveId}=require('./validation');
const {validateItemAndBin}=require('./inventory');
const {rebalanceReservations}=require('./document-reservations');
const {money}=require('./stock-valuation');

// Change the plan in place. Actual movements and confirmed payments are immutable.
async function updateDocument(tx,kind,id,body,user){
 const c=ops.config(kind),h=await ops.document(tx,kind,id);ops.editable(h);
 if(Number(body.base_revision)!==Number(h.revision_no))throw httpError(409,'Đơn đã thay đổi, vui lòng tải lại trước khi sửa');
 const code=String(body.code||'').trim(),date=requireDate(body.order_date),warehouse=requirePositiveId(body.warehouse_id,'Kho'),partner=requirePositiveId(body.partner_id,'Đối tác');
 if(!code||code.length>24)throw httpError(400,'Mã đơn từ 1 đến 24 ký tự');
 if(h.movements.length&&warehouse!==h.warehouse_id)throw httpError(409,'Không thể đổi kho khi đơn đã có lần nhập/xuất');
 if((h.payments.length||h.movements.some(m=>m.operation_status==='Confirmed'))&&partner!==h.partner_id)throw httpError(409,'Không thể đổi đối tác khi đơn đã có thanh toán hoặc giao dịch xác nhận');
 await ops.validHeader(tx,{warehouse_id:warehouse,partner_id:partner},user);
 if(!Array.isArray(body.items)||!body.items.length)throw httpError(400,'Đơn phải có sản phẩm');
 const seen=new Set(),ids=new Set(),lines=[];
 for(const raw of body.items){
  const detail=raw.id==null?null:requirePositiveId(raw.id,'Dòng hàng'),old=detail?h.items.find(d=>d.id===detail):null;
  if(detail&&(!old||ids.has(detail)))throw httpError(400,'Dòng hàng không thuộc đơn hoặc bị trùng');if(detail)ids.add(detail);
  if(raw.quantity_ordered==null||typeof raw.quantity_ordered==='boolean'||String(raw.quantity_ordered).trim()==='')throw httpError(400,'Lượng yêu cầu không hợp lệ');
  const item=requirePositiveId(raw.item_id,'Sản phẩm'),bin=requirePositiveId(raw.bin_id,'Vị trí'),quantity=ops.amount(raw.quantity_ordered,'Lượng yêu cầu'),price=ops.amount(raw.unit_price,'Đơn giá');
  const minimum=old?money(Number(old.fulfilled_quantity)+Number(old.pending_quantity)):0;
  if(quantity<minimum)throw httpError(409,`${old.item_code}: lượng yêu cầu không được thấp hơn lượng đã thực hiện và đang chờ (${minimum})`);
  if(old?.has_movements&&item!==old.item_id)throw httpError(409,`${old.item_code}: không thể đổi sản phẩm của dòng đã có lần nhập/xuất`);
  if(old&&bin!==old.bin_id&&Number(old.fulfilled_quantity)+Number(old.fulfilled_bonus)>0&&Number(old.remaining_quantity)<=0)throw httpError(409,`${old.item_code}: dòng đã thực hiện đủ, không thể đổi vị trí`);
  if(old&&Number(old.fulfilled_quantity)+Number(old.fulfilled_bonus)>0&&price!==Number(old.unit_price))throw httpError(409,`${old.item_code}: không thể đổi đơn giá của dòng đã được nhập/xuất xác nhận`);
  const tag=`${item}:${bin}`;if(seen.has(tag))throw httpError(400,'Dòng sản phẩm/vị trí bị trùng');seen.add(tag);
  // An unchanged historical catalog reference remains readable even if deactivated.
  if(!old||item!==old.item_id||bin!==old.bin_id||warehouse!==h.warehouse_id){const valid=await validateItemAndBin(tx,item,bin,warehouse);if(!valid.item_valid||!valid.bin_valid)throw httpError(409,'Sản phẩm/vị trí không hợp lệ');}
  lines.push({id:detail,item,bin,quantity,price,fulfilled:Number(old?.fulfilled_quantity||0),changed:!old||quantity!==Number(old.quantity_ordered)||item!==old.item_id||bin!==old.bin_id});
 }
 const removed=h.items.filter(d=>!ids.has(d.id));
 if(removed.some(d=>d.has_movements))throw httpError(409,'Không thể xóa dòng hàng đã có lần nhập/xuất');
 const total=money(lines.reduce((s,l)=>s+l.quantity*l.price,0));
 if(total>1e12)throw httpError(400,'Giá trị đơn tối đa 1.000 tỷ đồng');
 const committed=money(h.settled_amount+h.payments.filter(p=>p.operation_status==='Pending'&&['PAYMENT','ADVANCE'].includes(p.purpose)).reduce((s,p)=>s+Number(p.amount),0));
 if(total+0.005<committed)throw httpError(409,'Giá trị đơn mới thấp hơn tiền hàng đã thanh toán hoặc đang chờ xác nhận');
 if((c.r||h.lifecycle_status!=='Draft')&&lines.some(l=>l.changed))await require('./document-stock-limits').assertStockLimits(tx,kind,h,lines.map(l=>({item_id:l.item,bin_id:l.bin,quantity:Math.max(0,l.quantity-l.fulfilled)})),{plan:true});
 // Release this document's old holds before moving its remaining commitment.
 if(!c.r)await tx.request().input('id',sql.Int,h.id).query('UPDATE goods_issue_details SET reserved_quantity=0 WHERE goods_issue_id=@id');
 await tx.request().input('id',sql.Int,h.id).input('code',sql.NVarChar(24),code).input('date',sql.Date,date).input('warehouse',sql.Int,warehouse).input('partner',sql.Int,partner).input('note',sql.NVarChar(192),String(body.description||'').slice(0,192))
  .query(`UPDATE ${c.table} SET code=@code,order_date=@date,warehouse_id=@warehouse,partner_id=@partner,description=@note,revision_no=revision_no+1,updated_at=GETDATE() WHERE id=@id`);
 for(const d of removed)await tx.request().input('id',sql.Int,d.id).query(`DELETE FROM ${c.details} WHERE id=@id`);
 for(const l of lines){
  const q=tx.request().input('root',sql.Int,h.id).input('item',sql.Int,l.item).input('bin',sql.Int,l.bin).input('qty',sql.Decimal(18,2),l.quantity).input('price',sql.Decimal(18,2),l.price);
  if(l.id){
   await q.input('id',sql.Int,l.id).query(`UPDATE ${c.details} SET item_id=@item,bin_id=@bin,quantity_ordered=@qty,unit_price=@price,updated_at=GETDATE() WHERE id=@id;
    UPDATE x SET bin_id=@bin,unit_price=@price,inventory_value=ROUND(x.paid_quantity*@price,2),updated_at=GETDATE() FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE x.${c.df}=@id AND m.operation_status='Pending' AND m.operation_kind='${c.op}';`);
  }else await q.query(`INSERT ${c.details}(${c.fk},item_id,bin_id,quantity_ordered,unit_price) VALUES(@root,@item,@bin,@qty,@price)`);
 }
 await rebalanceReservations(tx);
 if(!c.r&&h.lifecycle_status==='Active'&&lines.some(l=>l.changed)){
  const updated=await ops.document(tx,kind,h.id);if(updated.items.some(d=>Number(d.reserved_quantity)+1e-8<Number(d.remaining_quantity)))throw httpError(409,'Không đủ hàng để giữ chỗ toàn bộ phần còn lại sau khi điều chỉnh');
 }
 return h.id;
}
module.exports={updateDocument};
