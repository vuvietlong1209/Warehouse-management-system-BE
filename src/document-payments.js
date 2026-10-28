const {sql}=require('./db');
const {httpError,requireDate,requirePositiveId}=require('./validation');
const {config,document,amount,key,hash,editable,validHeader,activate}=require('./document-operations');
const {rebalanceReservations}=require('./document-reservations');
const crypto=require('node:crypto');
const {todayKey}=require('./business-date');
async function checkPayment(tx,h,c,p,exclude=null){
  const value=Number(p.amount);if(p.purpose==='REFUND'){
    const original=h.payments.find(x=>x.id===Number(p.refund_of_id));if(!original||original.operation_status!=='Confirmed'||original.purpose==='REFUND')throw httpError(409,'Chọn khoản gốc đã xác nhận thuộc đúng đơn');
    const used=h.payments.filter(x=>x.refund_of_id===original.id&&['Pending','Confirmed'].includes(x.operation_status)&&x.id!==exclude).reduce((s,x)=>s+Number(x.amount),0);
    if(value>Number(original.amount)-used+1e-8)throw httpError(409,'Hoàn vượt tiền còn có thể hoàn');return;
  }
  if(p.purpose!=='SECURITY'){
    const pending=h.payments.filter(x=>x.operation_status==='Pending'&&['PAYMENT','ADVANCE'].includes(x.purpose)&&x.id!==exclude).reduce((s,x)=>s+Number(x.amount),0);
    if(value>h.planned_amount-h.settled_amount-pending+1e-8)throw httpError(409,'Số tiền vượt phần cam kết còn chưa thanh toán');
  }
}
async function createPayment(tx,kind,id,body,user,editId=null){
  const c=config(kind),h=await document(tx,kind,id);editable(h);const request=key(body.request_key),fingerprint=hash([kind,id,body]);
  if(editId){const old=h.payments.find(p=>p.id===editId);if(!old||old.operation_status!=='Pending')throw httpError(409,'Chỉ sửa khoản tiền chờ xác nhận');}
  else{const duplicate=(await tx.request().input('key',sql.UniqueIdentifier,request).query('SELECT id,request_hash FROM payments WHERE request_key=@key')).recordset[0];if(duplicate){if(duplicate.request_hash!==fingerprint)throw httpError(409,'Khoản tiền đã lưu với nội dung khác');return duplicate.id;}}
  const purpose=body.purpose||'PAYMENT';if(!['PAYMENT','ADVANCE','SECURITY','REFUND'].includes(purpose))throw httpError(400,'Loại giao dịch không hợp lệ');
  const p={amount:amount(body.amount,'Số tiền',true),purpose,refund_of_id:purpose==='REFUND'?requirePositiveId(body.refund_of_id,'Khoản gốc'):null};await checkPayment(tx,h,c,p,editId);
  const n=(await tx.request().input('id',sql.Int,h.id).query(`SELECT ISNULL(MAX(sequence_no),0)+1 n FROM payments WHERE ${c.fk}=@id`)).recordset[0].n;
  const direction=c.r?'OUT':'IN',code=String(body.code||`TC-${Date.now().toString(36).toUpperCase()}-${n}`).slice(0,24);
  const q=tx.request().input('code',sql.NVarChar(24),code).input('root',sql.Int,id).input('n',sql.Int,n).input('partner',sql.Int,h.partner_id).input('user',sql.Int,user)
    .input('dir',sql.VarChar(3),purpose==='REFUND'?(direction==='IN'?'OUT':'IN'):direction).input('purpose',sql.VarChar(12),purpose).input('a',sql.Decimal(18,2),p.amount)
    .input('date',sql.Date,requireDate(body.payment_date)).input('method',sql.NVarChar(32),String(body.method||'Chuyển khoản').slice(0,32)).input('note',sql.NVarChar(192),String(body.note||'').slice(0,192))
    .input('refund',sql.Int,p.refund_of_id).input('key',sql.UniqueIdentifier,request).input('hash',sql.VarChar(64),fingerprint);
  if(editId){await q.input('id',sql.Int,editId).query('UPDATE payments SET direction=@dir,purpose=@purpose,amount=@a,payment_date=@date,method=@method,note=@note,refund_of_id=@refund,request_hash=@hash WHERE id=@id');return editId;}
  return(await q.query(`INSERT payments(code,${c.fk},sequence_no,partner_id,user_id,direction,purpose,amount,payment_date,method,note,refund_of_id,request_key,request_hash) OUTPUT inserted.id VALUES(@code,@root,@n,@partner,@user,@dir,@purpose,@a,@date,@method,@note,@refund,@key,@hash)`)).recordset[0].id;
}
async function confirmPayment(tx,id,user,body={}){
  const p=(await tx.request().input('id',sql.Int,id).query('SELECT * FROM payments WITH(UPDLOCK,HOLDLOCK) WHERE id=@id')).recordset[0];if(!p||p.operation_status!=='Pending')throw httpError(409,'Khoản tiền không còn chờ xác nhận');
  const kind=p.goods_receipt_id?'receipt':'issue',c=config(kind),h=await document(tx,kind,p[c.fk]);editable(h);await validHeader(tx,h,user);await checkPayment(tx,h,c,p,id);
  const action=p.purpose==='SECURITY'?body.security_action:null;
  if(p.purpose==='SECURITY'&&!['KEEP','APPLY'].includes(action))throw httpError(400,'Chọn Xác nhận cọc hoặc Chuyển sang tiền hàng');
  if(action==='APPLY')await checkPayment(tx,h,c,{...p,purpose:'PAYMENT'},id);
  await tx.request().input('id',sql.Int,id).input('user',sql.Int,user).input('action',sql.VarChar(8),action).query("UPDATE payments SET operation_status='Confirmed',security_action=@action,confirmed_by=@user,confirmed_at=GETDATE() WHERE id=@id");
  let refund=null;
  if(action==='KEEP')refund=await createPayment(tx,kind,h.id,{purpose:'REFUND',refund_of_id:id,amount:Number(p.amount),payment_date:todayKey(),method:p.method,note:`Hoàn trả cọc ${p.code}`,request_key:crypto.randomUUID()},user);
  if(c.r)await activate(tx,c,h);await rebalanceReservations(tx);
  return {security_action:action,refund_payment_id:refund};
}
module.exports={createPayment,confirmPayment};
