const {sql}=require('./db');
const {getItemBinStock,getBinStock}=require('./inventory');
const {reservedQuantity}=require('./document-reservations');
const {httpError}=require('./validation');

// Pending receipts occupy proposed capacity; an issue may use its own reservation.
async function assertStockLimits(tx,kind,h,lines,{movementId=null,plan=false,date=null}={}){
 const groups=new Map();
 for(const line of lines){const key=kind==='receipt'?String(line.bin_id):`${line.item_id}:${line.bin_id}`;const group=groups.get(key)||{...line,quantity:0};group.quantity+=Number(line.quantity);groups.set(key,group);}
 for(const line of groups.values()){
  if(!(line.quantity>0))continue;
  if(kind==='receipt'){
   const b=(await tx.request().input('bin',sql.Int,line.bin_id).query('SELECT location_id,max_capacity FROM bins WHERE id=@bin')).recordset[0];if(!b)throw httpError(400,'Vị trí không tồn tại');
   const stock=await getBinStock(tx,line.bin_id);
   const pending=(await tx.request().input('bin',sql.Int,line.bin_id).input('root',sql.Int,plan?h.id:null).input('movement',sql.Int,movementId).query("SELECT ISNULL(SUM(x.quantity),0) n FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id JOIN goods_receipts h ON h.id=m.goods_receipt_id WHERE x.bin_id=@bin AND m.operation_kind='RECEIPT' AND m.operation_status='Pending' AND h.status=1 AND (@root IS NULL OR h.id<>@root) AND (@movement IS NULL OR m.id<>@movement)")).recordset[0].n;
   const free=Math.max(0,Number(b.max_capacity)-stock-Number(pending));
   if(line.quantity>free+1e-8)throw httpError(409,`Vị trí ${b.location_id}: chỉ còn sức chứa ${free}, lượng nhập ${line.quantity}`);
  }else{
   const current=await getItemBinStock(tx,line.item_id,line.bin_id),dated=date?await getItemBinStock(tx,line.item_id,line.bin_id,date):current;
   const held=await reservedQuantity(tx,line.item_id,line.bin_id,h.id);
   const pending=plan?0:(await tx.request().input('root',sql.Int,h.id).input('item',sql.Int,line.item_id).input('bin',sql.Int,line.bin_id).input('movement',sql.Int,movementId).query("SELECT ISNULL(SUM(x.quantity),0) n FROM stock_movement_details x JOIN stock_movements m ON m.id=x.stock_movement_id WHERE m.goods_issue_id=@root AND x.item_id=@item AND x.bin_id=@bin AND m.operation_status='Pending' AND m.operation_kind='ISSUE' AND (@movement IS NULL OR m.id<>@movement)")).recordset[0].n;
   const available=Math.max(0,Math.min(current,dated)-held-Number(pending));
   if(line.quantity>available+1e-8){const name=(await tx.request().input('item',sql.Int,line.item_id).input('bin',sql.Int,line.bin_id).query('SELECT i.code,b.location_id FROM items i CROSS JOIN bins b WHERE i.id=@item AND b.id=@bin')).recordset[0];throw httpError(409,`${name?.code||line.item_id} tại ${name?.location_id||line.bin_id}: lượng xuất khả thi còn ${available}, yêu cầu ${line.quantity}`);}
  }
 }
}
module.exports={assertStockLimits};
