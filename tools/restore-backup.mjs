// Восстановить базу из копии, снятой tools/backup-prod.mjs (24.08.2026).
//
// Заливает копию в УКАЗАННУЮ базу - по умолчанию в локальную проверочную, не в
// боевую: восстановление поверх живого салона делается осознанно и руками.
// Схему база должна иметь готовую (миграции накатаны), данные в ней будут стёрты.
//
// Запуск:
//   node tools/restore-backup.mjs <файл-копии> [имя-базы] [пользователь]
import pg from 'pg';
import { readFileSync } from 'node:fs';

const [file, dbName = 'alikhan_restore_check', dbUser = process.env.PGUSER] = process.argv.slice(2);
if (!file) {
  console.error('Укажите файл копии: node tools/restore-backup.mjs <файл> [база] [пользователь]');
  process.exit(1);
}
const dump = JSON.parse(readFileSync(file, 'utf8'));
const tables = Object.keys(dump.tables);

const db = new pg.Pool({
  host: process.env.PGHOST ?? '/tmp',
  database: dbName,
  user: dbUser,
  password: process.env.PGPASSWORD,
  max: 1,
});

async function service(sql, params = []) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    const res = await db.query(sql, params);
    await db.query('COMMIT');
    return res;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// Чистим в обратном порядке - сначала ссылающиеся, потом те, на кого ссылаются
for (const table of [...tables].reverse()) {
  await service(`DELETE FROM ${table}`);
}

let restored = 0;
for (const table of tables) {
  const rows = dump.tables[table];
  if (!rows.length) continue;
  const columns = Object.keys(rows[0]);
  const list = columns.map((c) => `"${c}"`).join(', ');
  for (const row of rows) {
    const values = columns.map((c) => row[c]);
    const holes = columns.map((_, i) => `$${i + 1}`).join(', ');
    await service(`INSERT INTO ${table} (${list}) VALUES (${holes})`, values);
    restored++;
  }
  // Счётчики (locations, schedule_shifts и т.п.) должны продолжиться с последнего id,
  // иначе первая же новая строка споткнётся о занятый номер
  const seq = await service(
    `SELECT pg_get_serial_sequence($1, a.attname) AS seq, a.attname AS col
       FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    [table]
  );
  for (const { seq: sequence, col } of seq.rows.filter((r) => r.seq)) {
    await service(`SELECT setval($1, GREATEST((SELECT MAX("${col}") FROM ${table}), 1))`, [sequence]);
  }
}

console.log(`Восстановлено строк: ${restored} из копии от ${dump.takenAt}`);
for (const table of tables) {
  const after = await service(`SELECT count(*)::int AS n FROM ${table}`);
  const expected = dump.tables[table].length;
  const mark = Number(after.rows[0].n) === expected ? '✔' : '✖';
  if (expected || Number(after.rows[0].n)) console.log(`  ${mark} ${table}: ${after.rows[0].n} (в копии ${expected})`);
}
await db.end();
