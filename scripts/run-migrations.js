const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('../src/db');

async function main() {
  const pool = await getPool();
  const migrationDir = path.resolve(__dirname, '../../database/migrations');
  const files = fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sqlText = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    const batches = sqlText.split(/^\s*GO\s*$/gim).map((part) => part.trim()).filter(Boolean);
    for (const batch of batches) await pool.request().batch(batch);
    console.log(`Applied ${file}`);
  }
  await pool.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
