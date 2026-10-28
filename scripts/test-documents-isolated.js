// Restore a disposable COPY of the user's verified backup. Never test writes on production.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {getPool,sql}=require('../src/db');
async function main(){
 const source=await getPool();let master;const name=`EWarehouseDocumentTest_${Date.now()}`;
 if(!/^EWarehouseDocumentTest_\d+$/.test(name))throw Error('Unsafe test database name');
 const backup=process.argv[2];if(!backup||!path.win32.isAbsolute(backup))throw Error('Supply an absolute verified SQL backup path');
 try{
  master=await new sql.ConnectionPool({...source.config,database:'master'}).connect();
  const directory=(await master.request().query(`SELECT CONVERT(nvarchar(4000),SERVERPROPERTY('InstanceDefaultDataPath')) directory`)).recordset[0].directory;
  const files=(await master.request().input('backup',sql.NVarChar(4000),backup).query('RESTORE FILELISTONLY FROM DISK=@backup')).recordset;
  const request=master.request().input('backup',sql.NVarChar(4000),backup);const moves=[];
  files.forEach((f,i)=>{request.input(`logical${i}`,sql.NVarChar(128),f.LogicalName).input(`file${i}`,sql.NVarChar(4000),path.win32.join(directory,`${name}_${i}.${f.Type==='L'?'ldf':'mdf'}`));moves.push(`MOVE @logical${i} TO @file${i}`);});
  await request.query(`RESTORE DATABASE [${name}] FROM DISK=@backup WITH ${moves.join(',')},RECOVERY;`);
  console.log('Disposable restored test database:',name);
  const pool=await new sql.ConnectionPool({...source.config,database:name}).connect();
  try{
   await require('../src/schema-check').checkSchema(pool);
   if(process.argv.includes('--serve-ui')){
    const hash=await require('bcryptjs').hash('DocumentUI2026!',10);
    await pool.request().input('password',sql.NVarChar(64),hash).query(`INSERT INTO users(username,password,name,status,role_id) SELECT N'document_ui_test',@password,N'Kiểm thử giao diện độc lập',1,id FROM roles WHERE code='ADMIN';`);
   }
  }finally{await pool.close();}
  await source.close();
  if(process.argv.includes('--serve-ui')){
   await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['src/server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DB_NAME:name,PORT:'4000'},stdio:'inherit',windowsHide:true});
    console.log('Isolated UI backend only. Send quit on stdin to stop and remove test database.');
    process.stdin.once('data',()=>child.kill());process.once('SIGINT',()=>child.kill());
    child.once('exit',()=>{process.stdin.pause();resolve();});child.once('error',reject);
   });
   return;
  }
  const args=process.argv.includes('--regression')?fs.readdirSync(path.resolve(__dirname,'../test')).filter(f=>f.endsWith('.test.js')).sort((a,b)=>Number(['document-workflow.test.js','document-reservation.test.js','forecast-scope.test.js'].includes(a))-Number(['document-workflow.test.js','document-reservation.test.js','forecast-scope.test.js'].includes(b))).map(f=>`test/${f}`):['test/document-workflow.test.js','test/document-reservation.test.js','test/forecast-scope.test.js'];
  const requested=process.argv.find(value=>value.startsWith('--tests='));
  const selected=requested?requested.slice(8).split(',').map(file=>{
   if(!/^[a-z0-9-]+\.test\.js$/.test(file)||!fs.existsSync(path.resolve(__dirname,'../test',file)))throw Error('Invalid test file');
   return `test/${file}`;
  }):args;
  const exit=await new Promise(resolve=>{const child=spawn(process.execPath,['--test','--test-force-exit','--test-timeout=600000','--test-concurrency=1',...selected],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DB_NAME:name,DOCUMENT_TEST_DB:name},stdio:'inherit',windowsHide:true});child.on('error',()=>resolve(1));child.on('exit',resolve);});
  process.exitCode=exit||0;
 }finally{
  await source.close();
  if(master){
   // Exact generated name, never DB_NAME or an arbitrary user-provided database.
   await master.request().query(`IF DB_ID(N'${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END;`);
   console.log('Removed disposable test database and its test data:',name);await master.close();
  }
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
