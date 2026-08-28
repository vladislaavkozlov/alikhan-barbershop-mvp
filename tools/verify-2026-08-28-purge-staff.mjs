// Репетиция удаления тестовых сотрудников на ЖИВОЙ базе (28.08.2026).
//
// Поддельный пул в тестах проверяет намерения механизма, но не проверяет базу: внешние
// ключи, каскады и замок арендатора живут в самом Postgres, и сломаться могут именно
// они. Поэтому здесь настоящая база под ОБЫЧНОЙ ролью (не суперпользователем, иначе
// замок из миграции 058 не действует и репетиция врёт), а данные - точная копия прода,
// снятая перед сбросом: те же двое тестовых, те же связи, тот же второй арендатор.
//
// Запуск:
//   node tools/verify-2026-08-28-purge-staff.mjs [база] [роль]
// По умолчанию alikhan_restore_check / alikhan_restore_role - база, в которую
// tools/restore-backup.mjs уже залил копию прода.
import pg from 'pg';

const DB = process.argv[2] ?? 'alikhan_restore_check';
const ROLE = process.argv[3] ?? 'alikhan_restore_role';
const HOST = process.env.PGHOST ?? '/tmp';
const PASSWORD = process.env.PGPASSWORD ?? 'probe';

process.env.DB_HOST = HOST;
process.env.DB_NAME = DB;
process.env.DB_USER = ROLE;
process.env.DB_PASSWORD = PASSWORD;
process.env.DB_SSL = 'disable';

const { pool: _pool } = await import('../api/lib/db.js');
const { parsePurgeStaffSpec, purgeStaff, purgeSnapshotKey } = await import('../api/lib/reset-tenant-data.js');

const admin = new pg.Pool({ host: HOST, database: DB, user: ROLE, password: PASSWORD, max: 1 });
const asSystem = async (sql, params = [], ctx = '*') => {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [ctx]);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
};

const checks = [];
const check = (ok, text) => {
  checks.push({ ok, text });
  console.log(`  ${ok ? '✔' : '✘'} ${text}`);
};

console.log(`Репетиция удаления тестовых сотрудников. База ${DB}, роль ${ROLE}\n`);

const safe = await asSystem('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
check(!safe.rows[0].rolsuper && !safe.rows[0].rolbypassrls, 'роль без суперправ: замок арендатора действует, репетиция не врёт');

const TENANT = 1;
const NAME = 'Барбершоп Алихан';
const IDS = ['staff-be6373da1266409ee97e3ecb', 'staff-47aa89cf150efdb1ddc3de9a'];
const LABEL = 'repeticiya-2026-08-28';

const countOf = async (table, where = '', params = []) =>
  Number((await asSystem(`SELECT count(*)::int AS n FROM ${table} ${where}`, params)).rows[0].n);

const before = {
  staff1: await countOf('staff', 'WHERE tenant_id = $1', [TENANT]),
  staff2: await countOf('staff', 'WHERE tenant_id = 2'),
  services2: await countOf('services', 'WHERE tenant_id = 2'),
  masterServices2: await countOf('master_services', 'WHERE tenant_id = 2'),
  targetServices: await countOf('master_services', 'WHERE master_id = ANY($1::text[])', [IDS]),
  targetSchedule: await countOf('master_weekly_schedule', 'WHERE master_id = ANY($1::text[])', [IDS]),
};
console.log(`\nДо операции: у арендатора 1 сотрудников ${before.staff1}, у арендатора 2 - ${before.staff2}`);
console.log(`Связей у двоих тестовых: компетенций ${before.targetServices}, строк графика ${before.targetSchedule}\n`);

// 1. Живого сотрудника вычеркнуть нельзя
const live = (await asSystem('SELECT id FROM staff WHERE tenant_id = $1 AND employed = true LIMIT 1', [TENANT])).rows[0].id;
try {
  await purgeStaff(parsePurgeStaffSpec(`${TENANT}:${NAME}:proba-zhivoy:${live}`), { log: () => {}, error: () => {} });
  check(false, 'живого сотрудника операция пропустила - это провал');
} catch (e) {
  check(/числятся в штате/.test(e.message), 'живого сотрудника вычеркнуть нельзя: операция отказала');
}

// 2. Несуществующий идентификатор останавливает операцию целиком
try {
  await purgeStaff(parsePurgeStaffSpec(`${TENANT}:${NAME}:proba-net:${IDS[0]},staff-net-takogo`), { log: () => {}, error: () => {} });
  check(false, 'операция прошла с несуществующим идентификатором - это провал');
} catch (e) {
  check(/этих сотрудников/.test(e.message), 'неизвестный идентификатор в списке останавливает операцию целиком');
}
check(await countOf('staff', 'WHERE id = $1', [IDS[0]]) === 1, 'после двух отказов ни один из названных не удалён');

// 3. Чужой арендатор недосягаем даже при верном имени и номере
const alien = (await asSystem('SELECT id FROM staff WHERE tenant_id = 2 LIMIT 1')).rows[0];
try {
  await purgeStaff(parsePurgeStaffSpec(`2:Урбашевичус - клиника авторской ортодонтии:proba-sosed:${alien.id}`), { log: () => {}, error: () => {} });
  check(false, 'операция прошла по клинике - это провал');
} catch (e) {
  check(/вертикаль/.test(e.message), 'клиника защищена вертикалью: операция отказала, не тронув ни строки');
}

// 4. Настоящий ход
const res = await purgeStaff(parsePurgeStaffSpec(`${TENANT}:${NAME}:${LABEL}:${IDS.join(',')}`), { log: () => {}, error: () => {} });
check(res.applied === true && res.deleted.staff === 2, `удалено ровно двое: staff ${res.deleted.staff}`);
check(await countOf('staff', 'WHERE id = ANY($1::text[])', [IDS]) === 0, 'в базе их больше нет');
check(await countOf('staff', 'WHERE tenant_id = $1', [TENANT]) === before.staff1 - 2, `у арендатора 1 осталось ${before.staff1 - 2} сотрудников, остальные целы`);
check(await countOf('master_services', 'WHERE master_id = ANY($1::text[])', [IDS]) === 0, 'их компетенции ушли вместе с ними');
check(await countOf('master_weekly_schedule', 'WHERE master_id = ANY($1::text[])', [IDS]) === 0, 'их строки графика ушли вместе с ними');

// 5. Сосед не шелохнулся
check(await countOf('staff', 'WHERE tenant_id = 2') === before.staff2, 'у клиники сотрудников столько же');
check(await countOf('services', 'WHERE tenant_id = 2') === before.services2, 'у клиники услуг столько же');
check(await countOf('master_services', 'WHERE tenant_id = 2') === before.masterServices2, 'у клиники компетенций столько же');

// 6. Снимок отката на месте и полон
const snap = await asSystem('SELECT value FROM kv_store WHERE key = $1', [purgeSnapshotKey(LABEL)]);
const value = typeof snap.rows[0].value === 'string' ? JSON.parse(snap.rows[0].value) : snap.rows[0].value;
check(value.tables.staff.length === 2, 'в снимке лежат обе полные строки сотрудников');
check(value.tables.master_services.length === before.targetServices, `в снимке ${value.tables.master_services.length} компетенций - столько же, сколько было`);
check(value.tables.master_weekly_schedule.length === before.targetSchedule, `в снимке ${value.tables.master_weekly_schedule.length} строк графика - столько же, сколько было`);

// 7. Повторный запуск ничего не делает
const again = await purgeStaff(parsePurgeStaffSpec(`${TENANT}:${NAME}:${LABEL}:${IDS.join(',')}`), { log: () => {}, error: () => {} });
check(again.applied === false, 'повторный старт с той же меткой не удаляет ничего');

// 8. Откат из снимка возвращает людей
const cols = (t) => Object.keys(value.tables[t][0] ?? {});
for (const table of ['staff', 'master_services', 'master_weekly_schedule']) {
  for (const row of value.tables[table]) {
    const c = cols(table);
    // Вставка идёт в контексте самого арендатора, а не в служебном: умолчание колонки
    // tenant_id (миграция 057) приводит контекст к числу, и на '*' это падает
    await asSystem(
      `INSERT INTO ${table} (${c.map((x) => `"${x}"`).join(', ')}) VALUES (${c.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING`,
      c.map((x) => row[x]),
      String(TENANT)
    );
  }
}
check(await countOf('staff', 'WHERE id = ANY($1::text[])', [IDS]) === 2, 'восстановление из снимка вернуло обоих сотрудников');
check(await countOf('master_services', 'WHERE master_id = ANY($1::text[])', [IDS]) === before.targetServices, 'восстановление вернуло их компетенции');

// pool из db.js - прокси на клиента текущего runInTenant, своего .end() у него нет:
// закрывается только собственный административный пул этой репетиции
await admin.end();

const bad = checks.filter((c) => !c.ok).length;
console.log(`\nПроверок ${checks.length}, провалов ${bad}`);
process.exit(bad === 0 ? 0 : 1);
