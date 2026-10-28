const express=require('express');
const router=express.Router();
const {getPool,sql}=require('../db');
const {httpError,requirePositiveId}=require('../validation');
const ops=require('../document-operations');
const {createPayment,confirmPayment}=require('../document-payments');
const {rebalanceReservations}=require('../document-reservations');
const error=(res,e)=>res.status(e.number===2601||e.number===2627?409:e.status||500).json({success:false,message:e.number===2601||e.number===2627?'Mã yêu cầu đã tồn tại':e.message,code:e.code,impact:e.impact});
const handle=fn=>async(req,res)=>{try{res.json(await fn(req));}catch(e){error(res,e);}};
router.get('/movements/:id',handle(async req=>{
  const pool=await getPool(),id=requirePositiveId(req.params.id,'Lần');const m=(await pool.request().input('id',sql.Int,id).query('SELECT m.*,u.name user_name,v.name confirmed_name FROM stock_movements m JOIN users u ON u.id=m.user_id LEFT JOIN users v ON v.id=m.confirmed_by WHERE m.id=@id')).recordset[0];if(!m)throw httpError(404,'Không tìm thấy lần');
  const h=await ops.document(pool,m.goods_receipt_id?'receipt':'issue',m.goods_receipt_id||m.goods_issue_id);
  m.items=(await pool.request().input('id',sql.Int,id).query('SELECT d.*,d.quantity quantity_ordered,i.code item_code,i.name item_name,u.code unit,b.location_id bin_code,b.description bin_description FROM stock_movement_details d JOIN items i ON i.id=d.item_id JOIN base_units u ON u.id=i.base_unit_id JOIN bins b ON b.id=d.bin_id WHERE stock_movement_id=@id ORDER BY d.id')).recordset;
  if(m.goods_receipt_id)m.items.forEach(d=>{d.commercial_unit_price=d.unit_price;d.unit_price=Number((Number(d.inventory_value)/Number(d.quantity)).toFixed(2));});
  return{...m,root:h};
}));
router.put('/movements/:id',handle(req=>ops.write(async tx=>{const m=(await tx.request().input('id',sql.Int,requirePositiveId(req.params.id,'Lần')).query('SELECT * FROM stock_movements WHERE id=@id')).recordset[0];if(!m)throw httpError(404,'Không tìm thấy lần');await ops.saveMovement(tx,m.goods_receipt_id?'receipt':'issue',m.goods_receipt_id||m.goods_issue_id,req.body,req.user.id,m.id);return{success:true};})));
router.get('/payments/:id',handle(async req=>{const pool=await getPool(),p=(await pool.request().input('id',sql.Int,requirePositiveId(req.params.id,'Khoản tiền')).query('SELECT p.*,original.purpose refund_of_purpose,original.security_action refund_of_security_action,original.code refund_of_code,u.name user_name,v.name confirmed_name FROM payments p LEFT JOIN payments original ON original.id=p.refund_of_id JOIN users u ON u.id=p.user_id LEFT JOIN users v ON v.id=p.confirmed_by WHERE p.id=@id')).recordset[0];if(!p)throw httpError(404,'Không tìm thấy khoản tiền');return{...p,root:await ops.document(pool,p.goods_receipt_id?'receipt':'issue',p.goods_receipt_id||p.goods_issue_id)};}));
router.put('/payments/:id',handle(req=>ops.write(async tx=>{const p=(await tx.request().input('id',sql.Int,requirePositiveId(req.params.id,'Khoản tiền')).query('SELECT * FROM payments WHERE id=@id')).recordset[0];if(!p)throw httpError(404,'Không tìm thấy khoản tiền');await createPayment(tx,p.goods_receipt_id?'receipt':'issue',p.goods_receipt_id||p.goods_issue_id,req.body,req.user.id,p.id);return{success:true};})));
router.post('/movements/:id/confirm',handle(req=>ops.write(async tx=>{const method=String(req.body.costing_method||'AVERAGE').toUpperCase();if(!['AVERAGE'].includes(method))throw httpError(400,'Phương pháp giá vốn không hợp lệ');await ops.confirmMovement(tx,requirePositiveId(req.params.id,'Lần'),req.user.id,method);return{success:true};})));
router.post('/payments/:id/confirm',handle(req=>ops.write(async tx=>({success:true,...await confirmPayment(tx,requirePositiveId(req.params.id,'Khoản tiền'),req.user.id,req.body)}))));
for(const [path,table]of [['movements','stock_movements'],['payments','payments']]){
  const editableOperation=async(tx,id)=>{
    const row=(await tx.request().input('id',sql.Int,id).query(`SELECT * FROM ${table} WITH(UPDLOCK,HOLDLOCK) WHERE id=@id`)).recordset[0];
    if(!row)throw httpError(404,'Không tìm thấy lần');
    ops.editable(await ops.header(tx,row.goods_receipt_id?'receipt':'issue',row.goods_receipt_id||row.goods_issue_id));return row;
  };
  router.post(`/${path}/:id/reject`,handle(req=>ops.write(async tx=>{
    const id=requirePositiveId(req.params.id,'Lần'),row=await editableOperation(tx,id);
    if(row.operation_status!=='Pending')throw httpError(409,'Chỉ từ chối lần đang chờ xác nhận');
    const reason=String(req.body?.reason||'').trim();if(!reason)throw httpError(400,'Nhập lý do từ chối');
    await tx.request().input('id',sql.Int,id).input('reason',sql.NVarChar(192),reason.slice(0,192)).input('user',sql.Int,req.user.id).query(`UPDATE ${table} SET operation_status='Rejected',reason=@reason,confirmed_by=@user,rejected_at=GETDATE() WHERE id=@id`);return{success:true};
  })));
  router.delete(`/${path}/:id`,handle(req=>ops.write(async tx=>{
    const id=requirePositiveId(req.params.id,'Lần'),row=await editableOperation(tx,id);
    if(!['Pending','Rejected','Cancelled'].includes(row.operation_status)||row.confirmed_at||row.source_document_id)throw httpError(409,'Không thể xóa lần đã được xác nhận');
    if(path==='payments'){
      if((await tx.request().input('id',sql.Int,id).query('SELECT TOP 1 id FROM payments WHERE refund_of_id=@id')).recordset.length)throw httpError(409,'Không thể xóa khoản tiền đã có giao dịch hoàn trả');
    }else await tx.request().input('id',sql.Int,id).query('DELETE FROM stock_movement_details WHERE stock_movement_id=@id');
    await tx.request().input('id',sql.Int,id).query(`DELETE FROM ${table} WHERE id=@id`);return{success:true};
  })));
}
function documentRouter(kind){
  const r=express.Router(),c=ops.config(kind);
  r.get('/postings',handle(async()=>{const pool=await getPool(),hs=(await pool.request().query(`SELECT h.*,w.name warehouse_name,p.name partner_name,u.name user_name FROM ${c.r?'receipt_transactions':'issue_transactions'} h JOIN warehouses w ON w.id=h.warehouse_id JOIN partners p ON p.id=h.partner_id JOIN users u ON u.id=h.user_id WHERE h.status=1 ORDER BY h.id DESC`)).recordset;
    const ds=(await pool.request().query(`SELECT d.*,i.code item_code,i.name item_name,b.description bin_description FROM ${c.r?'receipt_transaction_details':'issue_transaction_details'} d JOIN items i ON i.id=d.item_id JOIN bins b ON b.id=d.bin_id ORDER BY d.id`)).recordset;return hs.map(h=>({...h,items:ds.filter(d=>d[c.fk]===h.id)}));}));
  r.get('/',handle(async req=>{const pool=await getPool(),ids=(await pool.request().query(`SELECT id FROM ${c.table} WHERE status=1 OR lifecycle_status='Cancelled' ORDER BY id DESC`)).recordset;let rows=[];for(const h of ids)rows.push(await ops.document(pool,kind,h.id));
    const search=String(req.query.search||'').toLocaleLowerCase('vi');if(search)rows=rows.filter(h=>[h.code,h.partner_name,h.warehouse_name].join(' ').toLocaleLowerCase('vi').includes(search));if(req.query.status)rows=rows.filter(h=>h.lifecycle_status===req.query.status);
    if(req.query.page!==undefined||req.query.search!==undefined){const page=Math.max(1,parseInt(req.query.page)||1),size=Math.min(100,Math.max(5,parseInt(req.query.page_size)||25));return{data:rows.slice((page-1)*size,page*size),pagination:{page,page_size:size,total:rows.length,total_pages:Math.ceil(rows.length/size)}};}return rows;
  }));
  r.post('/initial',(req,res,next)=>{res.status(201);next();},handle(req=>ops.write(tx=>require('../document-initial').createInitial(tx,kind,req.body,req.user.id))));
  r.get('/:id',handle(req=>getPool().then(p=>ops.document(p,kind,req.params.id))));
  r.post('/',(req,res,next)=>{res.status(201);next();},handle(req=>ops.write(async tx=>{const id=await ops.saveDocument(tx,kind,req.body,req.user.id);return{success:true,[c.r?'receiptId':'issueId']:id,id};})));
  r.put('/:id',handle(req=>ops.write(async tx=>{await ops.saveDocument(tx,kind,req.body,req.user.id,requirePositiveId(req.params.id,'Đơn'));return{success:true};})));
  r.post('/:id/movements',handle(req=>ops.write(async tx=>({success:true,id:await ops.saveMovement(tx,kind,requirePositiveId(req.params.id,'Đơn'),req.body,req.user.id)}))));
  r.post('/:id/payments',handle(req=>ops.write(async tx=>({success:true,id:await createPayment(tx,kind,requirePositiveId(req.params.id,'Đơn'),req.body,req.user.id)}))));
  if(!c.r)r.post('/:id/reserve',handle(req=>ops.write(async tx=>{if(req.body.confirm_reserve!==true)throw httpError(400,'Cần xác nhận giữ chỗ');return require('../document-reservations').reserveDocument(tx,requirePositiveId(req.params.id,'Đơn'),req.user.id);})));
  r.post('/:id/revisions',handle(()=>{throw httpError(410,'Luồng điều chỉnh riêng đã ngừng sử dụng. Chọn Điều chỉnh đơn để sửa trực tiếp.');}));
  r.post('/:id/complete',handle(req=>ops.write(async tx=>{const h=await ops.document(tx,kind,req.params.id);ops.editable(h);if(req.body.confirm_complete!==true)throw httpError(400,'Cần xác nhận hoàn thành');if(h.completion_reason)throw httpError(409,h.completion_reason);await tx.request().input('id',sql.Int,h.id).input('user',sql.Int,req.user.id).query(`UPDATE ${c.table} SET lifecycle_status='Completed',completed_at=GETDATE(),completed_by=@user,updated_at=GETDATE() WHERE id=@id`);return{success:true};})));
  r.delete('/:id',handle(req=>ops.write(async tx=>{const h=await ops.document(tx,kind,req.params.id);if(!h.can_delete)throw httpError(409,'Không thể xóa: đơn đã có giao dịch/tiền được xác nhận hoặc đã hoàn thành');
    await tx.request().input('id',sql.Int,h.id).query(`UPDATE ${c.table} SET status=0,updated_at=GETDATE() WHERE id=@id;`);await rebalanceReservations(tx);return{success:true};})));
  // Compatibility for a one-batch voucher; all posting still uses the same service.
  r.patch('/:id/confirm',handle(req=>ops.write(async tx=>{const h=await ops.document(tx,kind,req.params.id),pending=h.movements.filter(m=>m.operation_kind===c.op&&m.operation_status==='Pending');if(pending.length!==1)throw httpError(409,'Chọn lần cần xác nhận trong popup Xử lý đơn');await ops.confirmMovement(tx,pending[0].id,req.user.id,req.body.costing_method||'AVERAGE');return{success:true};})));
  r.patch('/:id/reject',handle(req=>ops.write(async tx=>{const h=await ops.document(tx,kind,req.params.id);ops.editable(h);const pending=h.movements.filter(m=>m.operation_kind===c.op&&m.operation_status==='Pending');if(pending.length!==1)throw httpError(409,'Chọn lần cần từ chối');const reason=String(req.body.reason||'').trim();if(!reason)throw httpError(400,'Nhập lý do');await tx.request().input('id',sql.Int,pending[0].id).input('reason',sql.NVarChar(192),reason.slice(0,192)).query("UPDATE stock_movements SET operation_status='Rejected',reason=@reason,rejected_at=GETDATE() WHERE id=@id");return{success:true};})));
  return r;
}
module.exports={router,documentRouter,error};
