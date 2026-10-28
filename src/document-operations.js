const crypto=require('node:crypto');
const {sql}=require('./db');
const {httpError,requirePositiveId,requireDate}=require('./validation');
const {validateItemAndBin,validateDocumentHeader,getItemBinStock,getWeightedAverageCost}=require('./inventory');
const {captureStockPosting,validateStockPosting}=require('./stock-posting-guard');
const {lockLedger,reservedQuantity,rebalanceReservations}=require('./document-reservations');
const {syncOperationalHistoryAfterDocument}=require('./demand-history');
const {money}=require('./stock-valuation');
const {runSerializable}=require('./transaction');
const {paymentBalances}=require('./payment-accounting');
const config=kind=>{if(!['receipt','issue'].includes(kind))throw httpError(400,'Loại đơn không hợp lệ');const r=kind==='receipt';return{r,table:r?'goods_receipts':'goods_issues',details:r?'goods_receipt_details':'goods_issue_details',fk:r?'goods_receipt_id':'goods_issue_id',df:r?'goods_receipt_detail_id':'goods_issue_detail_id',op:r?'RECEIPT':'ISSUE'};};
function amount(v,label='Số lượng',positive=false){const n=Number(v);if(!Number.isFinite(n)||n<0||(positive&&n===0)||n>1e12||Math.abs(n*100-Math.round(n*100))>1e-4)throw httpError(400,`${label} không hợp lệ (tối đa 2 số thập phân)`);return n;}
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function key(v){if(!/^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(v||''))throw httpError(400,'Thiếu khóa chống ghi trùng, vui lòng tải lại biểu mẫu');return v;}
const write=fn=>runSerializable(async tx=>{await lockLedger(tx);return fn(tx);});
function editable(h){if(!h.status||['Completed','Cancelled'].includes(h.lifecycle_status))throw httpError(409,'Đơn đã hoàn thành/đóng, không thể ghi thêm hoặc chỉnh sửa');}
async function header(tx,kind,id){const c=config(kind);const h=(await tx.request().input('id',sql.Int,requirePositiveId(id,'Đơn')).query(`SELECT h.*,w.name warehouse_name,p.name partner_name,u.name user_name FROM ${c.table} h JOIN warehouses w ON w.id=h.warehouse_id JOIN partners p ON p.id=h.partner_id JOIN users u ON u.id=h.user_id WHERE h.id=@id AND (h.status=1 OR h.lifecycle_status='Cancelled')`)).recordset[0];if(!h)throw httpError(404,'Không tìm thấy đơn');return h;}
async function document(tx,kind,id){
  const c=config(kind),h=await header(tx,kind,id);
  h.items=(await tx.request().input('id',sql.Int,h.id).query(`SELECT d.*,i.code item_code,i.name item_name,u.code unit,b.location_id bin_code,b.description bin_description,
    CAST(CASE WHEN EXISTS(SELECT 1 FROM stock_movement_details x WHERE x.${c.df}=d.id) THEN 1 ELSE 0 END AS bit) has_movements,
    ISNULL((SELECT SUM(${c.r?'x.paid_quantity':'x.quantity'}) FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE x.${c.df}=d.id AND m.operation_kind='${c.op}' AND m.operation_status='Confirmed'),0) fulfilled_quantity,
    ISNULL((SELECT SUM(x.bonus_quantity) FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE x.${c.df}=d.id AND m.operation_kind='${c.op}' AND m.operation_status='Confirmed'),0) fulfilled_bonus,
    ISNULL((SELECT SUM(${c.r?'x.paid_quantity':'x.quantity'}) FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE x.${c.df}=d.id AND m.operation_kind='${c.op}' AND m.operation_status='Pending'),0) pending_quantity
    FROM ${c.details} d JOIN items i ON i.id=d.item_id JOIN base_units u ON u.id=i.base_unit_id JOIN bins b ON b.id=d.bin_id WHERE d.${c.fk}=@id ORDER BY d.id`)).recordset;
  h.items.forEach(d=>{d.fulfilled_cost_price=0;d.remaining_quantity=money(Number(d.quantity_ordered)-Number(d.fulfilled_quantity));d.recordable_quantity=Math.max(0,money(d.remaining_quantity-Number(d.pending_quantity)));});
  if(!c.r){const costs=(await tx.request().input('id',sql.Int,h.id).query("SELECT x.goods_issue_detail_id id,SUM(x.quantity*x.cost_price)/NULLIF(SUM(x.quantity),0) cost FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE m.goods_issue_id=@id AND m.operation_status='Confirmed' AND m.operation_kind='ISSUE' GROUP BY x.goods_issue_detail_id")).recordset;h.items.forEach(d=>{const cost=costs.find(x=>x.id===d.id);d.fulfilled_cost_price=Number(cost?.cost||0);});}
  h.movements=(await tx.request().input('id',sql.Int,h.id).query(`SELECT m.*,u.name user_name,v.name confirmed_name,(SELECT COUNT(DISTINCT item_id) FROM stock_movement_details WHERE stock_movement_id=m.id AND quantity>0) item_count,ISNULL((SELECT SUM(quantity) FROM stock_movement_details WHERE stock_movement_id=m.id),0) quantity,
    ISNULL((SELECT SUM(inventory_value) FROM stock_movement_details WHERE stock_movement_id=m.id),0) amount FROM stock_movements m JOIN users u ON u.id=m.user_id LEFT JOIN users v ON v.id=m.confirmed_by WHERE m.${c.fk}=@id ORDER BY m.id`)).recordset;
  h.payments=(await tx.request().input('id',sql.Int,h.id).query(`SELECT p.*,original.purpose refund_of_purpose,original.security_action refund_of_security_action,original.code refund_of_code,u.name user_name,v.name confirmed_name FROM payments p LEFT JOIN payments original ON original.id=p.refund_of_id JOIN users u ON u.id=p.user_id LEFT JOIN users v ON v.id=p.confirmed_by WHERE p.${c.fk}=@id ORDER BY p.id`)).recordset;
  const confirmed=h.payments.filter(p=>p.operation_status==='Confirmed');
  h.planned_amount=money(h.items.reduce((s,d)=>s+Number(d.quantity_ordered)*Number(d.unit_price),0));
  h.fulfilled_amount=money(h.movements.filter(m=>m.operation_kind===c.op&&m.operation_status==='Confirmed').reduce((s,m)=>s+Number(m.amount),0));
  Object.assign(h,paymentBalances(h.payments));
  h.outstanding_amount=Math.max(0,money(h.planned_amount-h.settled_amount));
  h.advance_balance=Math.max(0,money(h.settled_amount-h.fulfilled_amount));
  h.remaining_quantity=money(h.items.reduce((s,d)=>s+d.remaining_quantity,0));h.fulfilled_quantity=h.items.reduce((s,d)=>s+Number(d.fulfilled_quantity)+Number(d.fulfilled_bonus),0);
  h.reserved_quantity=h.items.reduce((s,d)=>s+Number(d.reserved_quantity||0),0);
  h.pending_count=h.movements.filter(m=>m.operation_status==='Pending').length+h.payments.filter(p=>p.operation_status==='Pending').length;
  h.can_delete=Boolean(h.status)&&!['Completed','Cancelled'].includes(h.lifecycle_status)&&!h.movements.some(m=>m.operation_status==='Confirmed')&&!confirmed.length;
  h.completion_reason=h.lifecycle_status==='Completed'?'Đơn đã hoàn thành':h.remaining_quantity>0?'Chưa thực hiện đủ lượng yêu cầu':h.pending_count?'Còn lần đang chờ xác nhận':h.outstanding_amount>0?'Còn tiền hàng chưa thanh toán':h.advance_balance>0?'Còn tiền ứng trước dư':h.security_balance>0?'Còn cọc bảo đảm chưa xử lý':h.reserved_quantity>0?'Còn hàng đang giữ':'';
  return h;
}
async function validHeader(tx,h,user){const v=await validateDocumentHeader(tx,{warehouseId:h.warehouse_id,partnerId:h.partner_id,userId:user});if(!v.warehouse_valid||!v.partner_valid||!v.user_valid)throw httpError(409,'Kho, đối tác hoặc tài khoản đã ngừng hoạt động');}
async function activate(tx,c,h){await tx.request().input('id',sql.Int,h.id).query(`UPDATE ${c.table} SET lifecycle_status='Active',activated_at=COALESCE(activated_at,GETDATE()),updated_at=GETDATE() WHERE id=@id`);}
async function saveMovement(tx,kind,id,body,user,editId=null){
  const c=config(kind),h=await document(tx,kind,id);editable(h);
  const date=requireDate(body.operation_date||body.order_date),request=key(body.request_key),fingerprint=hash([kind,id,date,body.items,body.description||'']);
  if(!editId){const old=(await tx.request().input('key',sql.UniqueIdentifier,request).query('SELECT id,request_hash FROM stock_movements WHERE request_key=@key')).recordset[0];if(old){if(old.request_hash!==fingerprint)throw httpError(409,'Yêu cầu đã lưu với nội dung khác');return old.id;}}
  else{const old=(await tx.request().input('id',sql.Int,editId).input('root',sql.Int,h.id).query(`SELECT * FROM stock_movements WHERE id=@id AND ${c.fk}=@root`)).recordset[0];if(!old||old.operation_status!=='Pending'||old.operation_kind!==c.op)throw httpError(409,'Chỉ sửa lần chờ xác nhận');}
  if(!Array.isArray(body.items)||!body.items.length)throw httpError(400,'Chọn sản phẩm thực hiện');
  const lines=[],seen=new Set(),totals=new Map();
  for(const raw of body.items){const d=h.items.find(x=>x.id===Number(raw.detail_id||raw[c.df]));if(!d)throw httpError(400,'Dòng hàng không thuộc đơn');
    const bin=requirePositiveId(raw.bin_id||d.bin_id,'Vị trí'),paid=amount(raw.quantity??raw.paid_quantity,'Lượng thực hiện'),bonus=c.r?amount(raw.bonus_quantity||0,'Lượng tặng'):0;if(paid+bonus===0)continue;
    if(bin!==d.bin_id)throw httpError(409,'Vị trí lấy theo đơn. Dùng Điều chỉnh đơn để đổi vị trí cho phần còn lại.');
    const tag=`${d.item_id}:${bin}`;if(seen.has(tag))throw httpError(400,'Sản phẩm/vị trí bị trùng');seen.add(tag);
    const v=await validateItemAndBin(tx,d.item_id,bin,h.warehouse_id);if(!v.item_valid||!v.bin_valid)throw httpError(409,'Sản phẩm/vị trí không hoạt động hoặc khác kho');
    const price=Number(d.unit_price);lines.push({detail:d.id,item:d.item_id,bin,paid,bonus,qty:money(paid+bonus),price,value:money(paid*price)});totals.set(d.id,(totals.get(d.id)||0)+paid);
  }
  if(!lines.length)throw httpError(400,'Số lượng lần thực hiện phải lớn hơn 0');
  for(const [detail,qty] of totals){const d=h.items.find(x=>x.id===detail);const others=(await tx.request().input('d',sql.Int,detail).input('edit',sql.Int,editId).query(`SELECT ISNULL(SUM(${c.r?'x.paid_quantity':'x.quantity'}),0) n FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE x.${c.df}=@d AND m.operation_status='Pending' AND (@edit IS NULL OR m.id<>@edit)`)).recordset[0];if(qty+Number(others.n)>d.remaining_quantity+1e-8)throw httpError(409,`${d.item_code}: vượt lượng còn được ghi nhận (${Math.max(0,d.remaining_quantity-Number(others.n))})`);}
  // Draft issues are plans; reserveDocument commits their physical stock.
  if(c.r||h.lifecycle_status!=='Draft')await require('./document-stock-limits').assertStockLimits(tx,kind,h,lines.map(l=>({item_id:l.item,bin_id:l.bin,quantity:l.qty})),{movementId:editId,date});
  let movement=editId;
  if(editId)await tx.request().input('id',sql.Int,editId).input('date',sql.Date,date).input('note',sql.NVarChar(192),String(body.description||'').slice(0,192)).input('hash',sql.VarChar(64),fingerprint).query('UPDATE stock_movements SET operation_date=@date,description=@note,request_hash=@hash,updated_at=GETDATE() WHERE id=@id; DELETE FROM stock_movement_details WHERE stock_movement_id=@id;');
  else{const n=(await tx.request().input('id',sql.Int,id).input('kind',sql.VarChar(12),c.op).query(`SELECT ISNULL(MAX(sequence_no),0)+1 n FROM stock_movements WHERE ${c.fk}=@id AND operation_kind=@kind`)).recordset[0].n;
    movement=(await tx.request().input('code',sql.NVarChar(64),`${h.code}-${c.r?'N':'X'}${String(n).padStart(2,'0')}`).input('n',sql.Int,n).input('op',sql.VarChar(12),c.op).input('root',sql.Int,id).input('date',sql.Date,date).input('user',sql.Int,user).input('key',sql.UniqueIdentifier,request).input('hash',sql.VarChar(64),fingerprint).input('note',sql.NVarChar(192),String(body.description||'').slice(0,192)).query(`INSERT stock_movements(code,sequence_no,operation_kind,${c.fk},operation_date,user_id,request_key,request_hash,description) OUTPUT inserted.id VALUES(@code,@n,@op,@root,@date,@user,@key,@hash,@note)`)).recordset[0].id;}
  for(const l of lines)await tx.request().input('m',sql.Int,movement).input('d',sql.Int,l.detail).input('i',sql.Int,l.item).input('b',sql.Int,l.bin).input('q',sql.Decimal(18,2),l.qty).input('p',sql.Decimal(18,2),l.paid).input('bonus',sql.Decimal(18,2),l.bonus).input('price',sql.Decimal(18,2),l.price).input('v',sql.Decimal(18,2),l.value).query(`INSERT stock_movement_details(stock_movement_id,${c.df},item_id,bin_id,quantity,paid_quantity,bonus_quantity,unit_price,inventory_value) VALUES(@m,@d,@i,@b,@q,@p,@bonus,@price,@v)`);
  return movement;
}
async function saveDocument(tx,kind,body,user,id=null,options={}){
  if(id)return require('./document-edit').updateDocument(tx,kind,id,body,user);
  const c=config(kind),code=String(body.code||'').trim(),date=requireDate(body.order_date);if(!code||code.length>24)throw httpError(400,'Mã đơn từ 1 đến 24 ký tự');
  const wh=requirePositiveId(body.warehouse_id,'Kho'),partner=requirePositiveId(body.partner_id,'Đối tác');await validHeader(tx,{warehouse_id:wh,partner_id:partner},user);
  if(!Array.isArray(body.items)||!body.items.length)throw httpError(400,'Đơn phải có sản phẩm');
  const request=body.request_key?key(body.request_key):crypto.randomUUID(),fingerprint=options.requestHash||hash([code,date,wh,partner,body.description||'',body.first_date||date,body.items]);
  if(!id){const old=(await tx.request().input('k',sql.UniqueIdentifier,request).query(`SELECT id,request_hash FROM ${c.table} WHERE request_key=@k`)).recordset[0];if(old){if(old.request_hash!==fingerprint)throw httpError(409,'Đơn đã lưu với nội dung khác');return old.id;}}
  const seen=new Set(),lines=[];for(const raw of body.items){const item=requirePositiveId(raw.item_id,'Sản phẩm'),bin=requirePositiveId(raw.bin_id,'Vị trí'),qty=amount(raw.quantity_ordered,'Lượng yêu cầu',true),price=amount(raw.unit_price,'Đơn giá'),first=amount(raw.first_quantity??0,'Lượng lần đầu'),bonus=c.r?amount(raw.first_bonus??raw.bonus_quantity??0,'Lượng tặng'):0;
    if(first>qty)throw httpError(400,'Lượng lần đầu vượt yêu cầu');const tag=`${item}:${bin}`;if(seen.has(tag))throw httpError(400,'Dòng sản phẩm/vị trí bị trùng');seen.add(tag);const valid=await validateItemAndBin(tx,item,bin,wh);if(!valid.item_valid||!valid.bin_valid)throw httpError(409,'Sản phẩm/vị trí không hợp lệ');lines.push({item,bin,qty,price,first,bonus});}
  if(lines.reduce((s,l)=>s+l.qty*l.price,0)>1e12)throw httpError(400,'Giá trị đơn tối đa 1.000 tỷ đồng');
  let q=tx.request().input('code',sql.NVarChar(24),code).input('date',sql.Date,date).input('w',sql.Int,wh).input('p',sql.Int,partner).input('user',sql.Int,user).input('note',sql.NVarChar(192),String(body.description||'').slice(0,192));
  if(id)await q.input('id',sql.Int,id).query(`UPDATE ${c.table} SET code=@code,order_date=@date,warehouse_id=@w,partner_id=@p,description=@note,updated_at=GETDATE() WHERE id=@id`);
  else id=(await q.input('key',sql.UniqueIdentifier,request).input('hash',sql.VarChar(64),fingerprint).query(`INSERT ${c.table}(code,order_date,warehouse_id,partner_id,user_id,description,lifecycle_status,request_key,request_hash) OUTPUT inserted.id VALUES(@code,@date,@w,@p,@user,@note,'${c.r?'Active':'Draft'}',@key,@hash)`)).recordset[0].id;
  const first=[];for(const l of lines){let rq=tx.request().input('root',sql.Int,id).input('i',sql.Int,l.item).input('b',sql.Int,l.bin).input('q',sql.Decimal(18,2),l.qty).input('price',sql.Decimal(18,2),l.price);
    const d=(await rq.query(`INSERT ${c.details}(${c.fk},item_id,bin_id,quantity_ordered,unit_price) OUTPUT inserted.id VALUES(@root,@i,@b,@q,@price)`)).recordset[0].id;
    if(l.first+l.bonus>0)first.push({detail_id:d,bin_id:l.bin,quantity:l.first,bonus_quantity:l.bonus});}
  if(first.length)await saveMovement(tx,kind,id,{operation_date:body.first_date||date,items:first,request_key:crypto.randomUUID(),description:body.description},user);
  return id;
}
async function confirmMovement(tx,id,user,method='AVERAGE'){
  method=String(method).toUpperCase();if(!['AVERAGE'].includes(method))throw httpError(400,'Phương pháp giá vốn không hợp lệ');
  const m=(await tx.request().input('id',sql.Int,id).query('SELECT * FROM stock_movements WITH(UPDLOCK,HOLDLOCK) WHERE id=@id')).recordset[0];if(!m)throw httpError(404,'Không tìm thấy lần thực hiện');
  if(m.operation_status!=='Pending')throw httpError(409,'Lần thực hiện không còn chờ xác nhận');const kind=m.goods_receipt_id?'receipt':'issue',c=config(kind),h=await document(tx,kind,m[c.fk]);editable(h);await validHeader(tx,h,user);
  if(!c.r&&h.lifecycle_status==='Draft')throw httpError(409,'Cần xác nhận Giữ chỗ trước khi duyệt xuất kho');
  if(m.operation_kind!==c.op)throw httpError(410,'Luồng điều chỉnh riêng đã ngừng sử dụng. Chọn Điều chỉnh đơn.');
  {
    const lines=(await tx.request().input('id',sql.Int,id).query('SELECT *,quantity quantity_ordered FROM stock_movement_details WHERE stock_movement_id=@id ORDER BY id')).recordset;
    if(!lines.length)throw httpError(400,'Lần thực hiện không có sản phẩm');const totals=new Map();
    for(const l of lines){const d=h.items.find(d=>d.id===l[c.df]);if(!d||d.item_id!==l.item_id)throw httpError(409,'Dòng không còn thuộc đơn');if(d.bin_id!==l.bin_id)throw httpError(409,'Vị trí lần chờ khác đơn. Chỉnh sửa và lưu lại lần thực hiện trước khi xác nhận.');totals.set(d.id,(totals.get(d.id)||0)+(c.r?Number(l.paid_quantity):Number(l.quantity)));const v=await validateItemAndBin(tx,l.item_id,l.bin_id,h.warehouse_id);if(!v.item_valid||!v.bin_valid)throw httpError(409,'Danh mục đã ngừng hoạt động');}
    for(const [d,q]of totals)if(q>h.items.find(x=>x.id===d).remaining_quantity+1e-8)throw httpError(409,'Lượng lần này vượt phần còn lại của đơn');
    const snapshot=await captureStockPosting(tx,h.warehouse_id,lines);
    for(const l of lines){if(!c.r){const available=await getItemBinStock(tx,l.item_id,l.bin_id,m.operation_date)-await reservedQuantity(tx,l.item_id,l.bin_id,h.id);if(Number(l.quantity)>available+1e-8)throw httpError(409,`Không đủ hàng chưa giữ tại vị trí ${l.bin_id}: còn ${available}`);
      const cost=await getWeightedAverageCost(tx,l.item_id,h.warehouse_id,m.operation_date);
      if(!Number.isFinite(cost)||cost<0)throw httpError(409,'Không xác định được giá vốn');await tx.request().input('id',sql.Int,l.id).input('cost',sql.Decimal(18,2),money(cost)).query('UPDATE stock_movement_details SET cost_price=@cost WHERE id=@id');
      await tx.request().input('id',sql.Int,l.goods_issue_detail_id).input('q',sql.Decimal(18,2),l.quantity).query('UPDATE goods_issue_details SET reserved_quantity=CASE WHEN reserved_quantity>@q THEN reserved_quantity-@q ELSE 0 END WHERE id=@id');
    }}
    await tx.request().input('id',sql.Int,id).input('user',sql.Int,user).query("UPDATE stock_movements SET operation_status='Confirmed',confirmed_by=@user,confirmed_at=GETDATE(),updated_at=GETDATE() WHERE id=@id");
    await validateStockPosting(tx,snapshot);
    await syncOperationalHistoryAfterDocument(tx,{date:new Date(m.operation_date).toISOString().slice(0,10),warehouseId:h.warehouse_id,itemIds:lines.map(l=>l.item_id),createdBy:user});
  }
  await activate(tx,c,h);await rebalanceReservations(tx);
}
module.exports={config,amount,hash,key,write,editable,header,document,saveDocument,saveMovement,confirmMovement,activate,validHeader};
