// Разовый сброс рабочих данных арендатора (27.08.2026, передача кабинета заказчику).
// Тесты написаны до выхода на прод и держат обещания механизма:
//   - контекст АРЕНДАТОРА, а не служебный '*': замок из миграции 058 обязан быть на
//     месте, чужие строки физически недосягаемы;
//   - сверка названия: номер арендатора - одна цифра, опечатка в ней стирает не тот
//     салон, поэтому расхождение имени останавливает операцию до единого DELETE;
//   - снимок в kv_store пишется ДО удаления, иначе откатывать нечем;
//   - график пишется ПОСЛЕ удаления (PUT /master-weekly-schedule отказывает с 409
//     schedule_conflict, когда график задевает живые брони);
//   - идемпотентность по метке: переменную забыли убрать из панели, контейнер
//     перезапустился через месяц - не удаляется ничего;
//   - ошибка на любом шаге откатывает всё, кривая переменная не роняет приложение.
// Настоящий Postgres здесь не нужен - под db.js подставляется поддельный пул.
// Живой прогон на настоящей базе - tools/verify-2026-08-27-sbros-dannyh.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { __setBasePoolForTests } from '../api/lib/db.js';
import {
  DROP_SNAPSHOT_VARIABLE,
  RESET_TABLES,
  SNAPSHOT_TABLES,
  dropResetSnapshot,
  dropResetSnapshotFromEnv,
  parseResetSpec,
  resetTenantData,
  resetTenantDataFromEnv,
  snapshotKey,
} from '../api/lib/reset-tenant-data.js';

const VARIABLE = '1:Барбершоп Алихан:peredacha-zakazchiku-2026-08-27';
const SPEC = parseResetSpec(VARIABLE);

function fakePool(reply) {
  const state = { queries: [], live: 0 };
  return {
    state,
    async connect() {
      state.live++;
      return {
        async query(text, params) {
          const sql = typeof text === 'string' ? text : text?.text ?? '';
          state.queries.push({ sql: sql.trim(), params });
          return reply(sql.trim(), params, state) ?? { rows: [], rowCount: 0 };
        },
        release() {
          state.live--;
        },
      };
    },
  };
}

// Обычный ответ базы: арендатор 1 называется как в заявке, снимка ещё нет, в штате
// двое, каждая очищаемая таблица отдаёт по одной строке и удаляет по три
const collector = (over = {}) => (sql) => {
  if (/FROM tenants WHERE id/i.test(sql)) return over.tenant ?? { rows: [{ id: 1, name: 'Барбершоп Алихан', vertical: 'barbershop' }], rowCount: 1 };
  if (/FROM kv_store WHERE key/i.test(sql)) return over.snapshot ?? { rows: [], rowCount: 0 };
  if (/^SELECT \* FROM/i.test(sql)) return { rows: [{ id: 'row-1' }], rowCount: 1 };
  if (/^SELECT id, name, role FROM staff/i.test(sql)) {
    return over.staff ?? { rows: [{ id: 'master-1', name: 'Алиовсад', role: 'master' }, { id: 'admin-1', name: 'Ренат', role: 'admin' }], rowCount: 2 };
  }
  if (/^DELETE FROM/i.test(sql)) return { rows: [], rowCount: 3 };
  return { rows: [], rowCount: 0 };
};

const silent = () => ({ log: () => {}, error: () => {} });
const sqlsOf = (fake) => fake.state.queries.map((q) => q.sql);
const findQuery = (fake, re) => fake.state.queries.filter((q) => re.test(q.sql));
const indexOf = (fake, re) => sqlsOf(fake).findIndex((sql) => re.test(sql));
const lastIndexOf = (fake, re) => sqlsOf(fake).map((sql) => re.test(sql)).lastIndexOf(true);

test.afterEach(() => __setBasePoolForTests(null));

// ── Разбор переменной ───────────────────────────────────────────────────────

test('заявка разбирается на номер, название и метку', () => {
  assert.deepEqual(SPEC, { tenantId: 1, tenantName: 'Барбершоп Алихан', label: 'peredacha-zakazchiku-2026-08-27' });
});

test('переменной нет или она пуста - тишина, а не ошибка', () => {
  assert.equal(parseResetSpec(undefined), null);
  assert.equal(parseResetSpec(''), null);
  assert.equal(parseResetSpec('   '), null);
});

test('кавычка и восклицательный знак отсекаются: панель Amvera такое значение не примет', () => {
  assert.throws(() => parseResetSpec('1:"Барбершоп Алихан":metka'), /кавычка/);
  assert.throws(() => parseResetSpec('1:Барбершоп Алихан!:metka'), /восклицательный/);
});

test('номер арендатора обязан быть числом, название - непустым, метка - латиницей', () => {
  assert.throws(() => parseResetSpec('один:Барбершоп Алихан:metka'), /не число/);
  assert.throws(() => parseResetSpec('1::metka'), /название/);
  assert.throws(() => parseResetSpec('1:Барбершоп Алихан:метка сброса'), /метка/);
  assert.throws(() => parseResetSpec('1:Барбершоп Алихан'), /не похоже на заявку/);
});

test('двоеточие внутри названия не съедает часть названия', () => {
  assert.deepEqual(parseResetSpec('2:Клиника: авторская ортодонтия:metka-2026'), {
    tenantId: 2,
    tenantName: 'Клиника: авторская ортодонтия',
    label: 'metka-2026',
  });
});

// ── Сама операция ───────────────────────────────────────────────────────────

test('сброс идёт одной транзакцией в контексте АРЕНДАТОРА, а не в служебном', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const result = await resetTenantData(SPEC, silent());

  const sqls = sqlsOf(fake);
  assert.equal(sqls[0], 'BEGIN');
  assert.match(sqls[1], /set_config\('app\.tenant_id'/);
  // Именно '1', а не '*': в служебном контексте замок из 058_rls.sql снят, и ошибка
  // в условии запроса дотянулась бы до чужого арендатора
  assert.deepEqual(fake.state.queries[1].params, ['1']);
  assert.equal(sqls.at(-1), 'COMMIT');
  assert.equal(fake.state.live, 0, 'соединение возвращено в пул');
  assert.equal(result.applied, true);
});

test('порядок удаления безопасен по внешним ключам', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await resetTenantData(SPEC, silent());
  const deletes = findQuery(fake, /^DELETE FROM/i)
    .map((q) => q.sql.split(/\s+/)[2])
    .filter((table) => RESET_TABLES.includes(table));
  assert.deepEqual(deletes, [
    'notifications',
    'sales',
    'booking_services',
    'bookings',
    'clients',
    'schedule_breaks',
    'schedule_shifts',
    'schedule_change_requests',
  ]);
});

test('в каждом удалении арендатор стоит явным условием - второй рубеж поверх замка', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await resetTenantData(SPEC, silent());
  for (const q of findQuery(fake, /^DELETE FROM/i).filter((q) => RESET_TABLES.includes(q.sql.split(/\s+/)[2]))) {
    assert.match(q.sql, /WHERE tenant_id = \$1/, `удаление без условия по арендатору: ${q.sql}`);
    assert.deepEqual(q.params, [1]);
  }
});

test('название арендатора не совпало - ни одного удаления, транзакция откатана', async () => {
  const fake = fakePool(collector({ tenant: { rows: [{ id: 1, name: 'Урбашевичус - клиника авторской ортодонтии', vertical: 'clinic' }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => resetTenantData(SPEC, silent()), /называется/);
  const sqls = sqlsOf(fake);
  assert.equal(findQuery(fake, /^DELETE FROM/i).length, 0, 'при расхождении имени не удаляется ничего');
  assert.equal(findQuery(fake, /^INSERT INTO/i).length, 0, 'и не пишется ничего');
  assert.ok(sqls.includes('ROLLBACK'));
  assert.ok(!sqls.includes('COMMIT'));
});

test('арендатора с таким номером нет - тот же отказ без единого удаления', async () => {
  const fake = fakePool(collector({ tenant: { rows: [], rowCount: 0 } }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => resetTenantData(SPEC, silent()), /в базе нет/);
  assert.equal(findQuery(fake, /^DELETE FROM/i).length, 0);
});

test('снимок для отката пишется ДО первого удаления и содержит все девять таблиц, включая недельный график', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await resetTenantData(SPEC, silent());

  const selects = findQuery(fake, /^SELECT \* FROM/i).map((q) => q.sql.split(/\s+/)[3]);
  assert.deepEqual(selects, SNAPSHOT_TABLES, 'снимаются очищаемые таблицы плюс недельный график');

  const snapshotAt = indexOf(fake, /^INSERT INTO kv_store/i);
  const firstDeleteAt = indexOf(fake, /^DELETE FROM/i);
  assert.ok(snapshotAt > 0, 'снимок записан');
  assert.ok(snapshotAt < firstDeleteAt, 'снимок, снятый после удаления, пуст по построению');

  const [insert] = findQuery(fake, /^INSERT INTO kv_store/i);
  assert.deepEqual(insert.params[0], 1, 'снимок принадлежит тому же арендатору');
  assert.equal(insert.params[1], snapshotKey('peredacha-zakazchiku-2026-08-27'));
  const value = JSON.parse(insert.params[2]);
  assert.deepEqual(Object.keys(value.tables), SNAPSHOT_TABLES);
  assert.equal(value.tables.bookings.length, 1, 'строки записи попали в снимок');
  // Недельный график операция не удаляет, а заменяет целиком: без него в снимке
  // прежние часы работы салона не вернуть ничем
  assert.equal(value.tables.master_weekly_schedule.length, 1, 'прежний недельный график попал в снимок');
  assert.match(value.takenAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('график пишется ПОСЛЕ удаления записей: иначе он спорил бы с живыми бронями', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await resetTenantData(SPEC, silent());
  const lastDataDeleteAt = lastIndexOf(fake, /^DELETE FROM (notifications|sales|booking_services|bookings|clients|schedule_breaks|schedule_shifts|schedule_change_requests)/i);
  const staffAt = indexOf(fake, /^SELECT id, name, role FROM staff/i);
  const firstScheduleAt = indexOf(fake, /^INSERT INTO master_weekly_schedule/i);
  assert.ok(lastDataDeleteAt < staffAt, 'состав читается уже после чистки');
  assert.ok(staffAt < firstScheduleAt);
});

test('график получают только сотрудники в штате: 7 дней, 08:00-20:00, перерыв 13:00-14:00', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const result = await resetTenantData(SPEC, silent());

  const [staffQuery] = findQuery(fake, /^SELECT id, name, role FROM staff/i);
  assert.match(staffQuery.sql, /employed = true/, 'уволенным график не пишется');
  assert.match(staffQuery.sql, /tenant_id = \$1/);

  const inserts = findQuery(fake, /^INSERT INTO master_weekly_schedule/i);
  assert.equal(inserts.length, 14, '7 дней на каждого из двоих в штате');
  assert.equal(result.scheduled, 2);

  // Прежний график заменяется целиком (writeWeeklySchedule), а не дописывается поверх
  assert.equal(findQuery(fake, /^DELETE FROM master_weekly_schedule WHERE master_id/i).length, 2);

  const forMaster = inserts.filter((q) => q.params[0] === 'master-1');
  assert.deepEqual(forMaster.map((q) => q.params[1]), [1, 2, 3, 4, 5, 6, 7]);
  for (const q of forMaster) {
    assert.deepEqual(q.params.slice(2), [true, '08:00', '20:00', '13:00', '14:00']);
  }
});

// График уволенного - такой же след тестового периода, как и запись клиента, а
// writeWeeklySchedule чистит строки только тех, кому пишет
test('строки графика тех, кого нет в штате, снимаются до записи нового графика', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const result = await resetTenantData(SPEC, silent());

  const [stale] = findQuery(fake, /^DELETE FROM master_weekly_schedule\s+WHERE tenant_id/i);
  assert.ok(stale, 'уборка чужих строк графика не выполнена');
  assert.match(stale.sql, /NOT IN \(SELECT id FROM staff WHERE tenant_id = \$1 AND employed = true\)/);
  assert.deepEqual(stale.params, [1]);
  assert.equal(result.staleScheduleRemoved, 3);

  const staleAt = indexOf(fake, /^DELETE FROM master_weekly_schedule\s+WHERE tenant_id/i);
  const firstScheduleAt = indexOf(fake, /^INSERT INTO master_weekly_schedule/i);
  const lastDataDeleteAt = lastIndexOf(fake, /^DELETE FROM (notifications|sales|booking_services|bookings|clients|schedule_breaks|schedule_shifts|schedule_change_requests)/i);
  assert.ok(lastDataDeleteAt < staleAt && staleAt < firstScheduleAt);
});

test('повторный старт с той же меткой: applied false и ни одного удаления', async () => {
  const fake = fakePool(collector({ snapshot: { rows: [{ updated_at: '2026-08-27T10:00:00.000Z' }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  const lines = [];
  const result = await resetTenantData(SPEC, { log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) });

  assert.equal(result.applied, false);
  assert.equal(findQuery(fake, /^DELETE FROM/i).length, 0, 'второй прогон не удаляет ничего');
  assert.equal(findQuery(fake, /^INSERT INTO/i).length, 0, 'и не переписывает снимок');
  assert.match(lines.join('\n'), /уже выполнен/);
});

test('сбой на записи графика откатывает и удаление, и снимок', async () => {
  const fake = fakePool((sql) => {
    if (/^INSERT INTO master_weekly_schedule/i.test(sql)) throw new Error('база отказала');
    return collector()(sql);
  });
  __setBasePoolForTests(fake);
  await assert.rejects(() => resetTenantData(SPEC, silent()), /база отказала/);
  const sqls = sqlsOf(fake);
  assert.ok(sqls.includes('ROLLBACK'), 'транзакция откатана целиком');
  assert.ok(!sqls.includes('COMMIT'), 'половины сброса не остаётся');
  assert.equal(fake.state.live, 0, 'соединение возвращено в пул даже при сбое');
});

test('сбой на удалении тоже откатывает всё', async () => {
  const fake = fakePool((sql) => {
    if (/^DELETE FROM bookings/i.test(sql)) throw new Error('база отказала');
    return collector()(sql);
  });
  __setBasePoolForTests(fake);
  await assert.rejects(() => resetTenantData(SPEC, silent()), /база отказала/);
  assert.ok(sqlsOf(fake).includes('ROLLBACK'));
  assert.ok(!sqlsOf(fake).includes('COMMIT'));
});

// ── Обёртка старта приложения ───────────────────────────────────────────────

test('кривая переменная не роняет приложение: ошибка в лог, база не тронута', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const errors = [];
  const result = await resetTenantDataFromEnv({ RESET_TENANT_DATA: 'Барбершоп Алихан' }, { log: () => {}, error: (m) => errors.push(String(m)) });
  assert.equal(result, null);
  assert.equal(fake.state.queries.length, 0, 'в базу не ушло ни одного запроса');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /RESET_TENANT_DATA/);
});

test('расхождение имени через обёртку тоже не роняет приложение', async () => {
  const fake = fakePool(collector({ tenant: { rows: [{ id: 1, name: 'Другое заведение', vertical: 'barbershop' }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  const errors = [];
  const result = await resetTenantDataFromEnv({ RESET_TENANT_DATA: VARIABLE }, { log: () => {}, error: (m) => errors.push(String(m)) });
  assert.equal(result, null);
  assert.equal(findQuery(fake, /^DELETE FROM/i).length, 0);
  assert.match(errors[0], /сброс не выполнен/);
});

test('переменная не задана - ни базы, ни ошибок', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const errors = [];
  assert.equal(await resetTenantDataFromEnv({}, { log: () => {}, error: (m) => errors.push(m) }), null);
  assert.equal(await resetTenantDataFromEnv({ RESET_TENANT_DATA: '' }, { log: () => {}, error: (m) => errors.push(m) }), null);
  assert.equal(fake.state.queries.length, 0);
  assert.equal(errors.length, 0);
});

test('в лог уходят построчные счётчики и напоминание убрать переменную из панели', async () => {
  __setBasePoolForTests(fakePool(collector()));
  const lines = [];
  await resetTenantDataFromEnv({ RESET_TENANT_DATA: VARIABLE }, { log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) });
  const text = lines.join('\n');
  for (const table of RESET_TABLES) assert.match(text, new RegExp(`${table}: удалено строк 3`));
  assert.match(text, /Барбершоп Алихан/);
  assert.match(text, /сотрудникам в штате: 2/);
  assert.match(text, /кого в штате нет: 3/);
  assert.match(text, /RESET_TENANT_DATA из панели/);
});

// ── Второй рубеж: вертикаль арендатора ──────────────────────────────────────
// Сверка имени ловит опечатку в номере. Она не ловит согласованную ошибку: номер
// клиники и имя клиники, аккуратно списанные с чужого листка, друг с другом сойдутся

test('вертикаль не барбершоп - отказ, даже когда номер и название сошлись', async () => {
  const spec = parseResetSpec('2:Урбашевичус - клиника авторской ортодонтии:peredacha-2026-08-27');
  const fake = fakePool(collector({
    tenant: { rows: [{ id: 2, name: 'Урбашевичус - клиника авторской ортодонтии', vertical: 'clinic' }], rowCount: 1 },
  }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => resetTenantData(spec, silent()), /вертикаль «clinic»/);
  assert.equal(findQuery(fake, /^DELETE FROM/i).length, 0, 'у клиники не удаляется ничего');
  assert.equal(findQuery(fake, /^INSERT INTO/i).length, 0, 'и снимок не пишется');
  assert.ok(sqlsOf(fake).includes('ROLLBACK'));
  assert.ok(!sqlsOf(fake).includes('COMMIT'));
});

test('пустая вертикаль - тоже отказ: белый список, а не чёрный', async () => {
  const fake = fakePool(collector({ tenant: { rows: [{ id: 1, name: 'Барбершоп Алихан', vertical: null }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => resetTenantData(SPEC, silent()), /разрешён только для: barbershop/);
  assert.equal(findQuery(fake, /^DELETE FROM/i).length, 0);
});

test('в лог сброса уходит штатный способ снять снимок после первого дня', async () => {
  __setBasePoolForTests(fakePool(collector()));
  const lines = [];
  await resetTenantDataFromEnv({ RESET_TENANT_DATA: VARIABLE }, { log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) });
  const text = lines.join('\n');
  assert.match(text, /RESET_TENANT_DATA_DROP_SNAPSHOT=1:Барбершоп Алихан:peredacha-zakazchiku-2026-08-27/);
  assert.match(text, /телефонами/);
  assert.match(text, new RegExp(`таблиц в нём ${SNAPSHOT_TABLES.length}`));
});

// ── Снятие снимка отката ────────────────────────────────────────────────────

const dropReply = (over = {}) => (sql, params, state) => {
  if (/FROM tenants WHERE id/i.test(sql)) return over.tenant ?? { rows: [{ id: 1, name: 'Барбершоп Алихан', vertical: 'barbershop' }], rowCount: 1 };
  if (/^DELETE FROM kv_store/i.test(sql)) return over.removed ?? { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};

test('снимок снимается в контексте арендатора, по ключу метки и одной транзакцией', async () => {
  const fake = fakePool(dropReply());
  __setBasePoolForTests(fake);
  const result = await dropResetSnapshot(SPEC, silent());

  const sqls = sqlsOf(fake);
  assert.equal(sqls[0], 'BEGIN');
  assert.match(sqls[1], /set_config\('app\.tenant_id'/);
  assert.deepEqual(fake.state.queries[1].params, ['1']);
  assert.equal(sqls.at(-1), 'COMMIT');

  const [del] = findQuery(fake, /^DELETE FROM kv_store/i);
  assert.match(del.sql, /WHERE tenant_id = \$1 AND key = \$2/);
  assert.deepEqual(del.params, [1, snapshotKey('peredacha-zakazchiku-2026-08-27')]);
  assert.deepEqual(
    { dropped: result.dropped, removed: result.removed, key: result.key },
    { dropped: true, removed: 1, key: snapshotKey('peredacha-zakazchiku-2026-08-27') }
  );
  assert.equal(fake.state.live, 0, 'соединение возвращено в пул');
});

test('снимка уже нет - честный лог и никакой ошибки', async () => {
  const fake = fakePool(dropReply({ removed: { rows: [], rowCount: 0 } }));
  __setBasePoolForTests(fake);
  const lines = [];
  const result = await dropResetSnapshot(SPEC, { log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) });
  assert.equal(result.dropped, false);
  assert.equal(result.removed, 0);
  assert.match(lines.join('\n'), /убирать нечего/);
});

test('снятие снимка тоже проверяет имя и вертикаль: чужую строку эта операция не трогает', async () => {
  const wrongName = fakePool(dropReply({ tenant: { rows: [{ id: 1, name: 'Другое заведение', vertical: 'barbershop' }], rowCount: 1 } }));
  __setBasePoolForTests(wrongName);
  await assert.rejects(() => dropResetSnapshot(SPEC, silent()), /называется/);
  assert.equal(findQuery(wrongName, /^DELETE FROM/i).length, 0);

  const wrongVertical = fakePool(dropReply({ tenant: { rows: [{ id: 1, name: 'Барбершоп Алихан', vertical: 'clinic' }], rowCount: 1 } }));
  __setBasePoolForTests(wrongVertical);
  await assert.rejects(() => dropResetSnapshot(SPEC, silent()), /вертикаль «clinic»/);
  assert.equal(findQuery(wrongVertical, /^DELETE FROM/i).length, 0);
  assert.ok(sqlsOf(wrongVertical).includes('ROLLBACK'));
});

test('кривая переменная снятия снимка не роняет приложение и не ходит в базу', async () => {
  const fake = fakePool(dropReply());
  __setBasePoolForTests(fake);
  const errors = [];
  const result = await dropResetSnapshotFromEnv(
    { [DROP_SNAPSHOT_VARIABLE]: '1:Барбершоп Алихан' },
    { log: () => {}, error: (m) => errors.push(String(m)) }
  );
  assert.equal(result, null);
  assert.equal(fake.state.queries.length, 0, 'в базу не ушло ни одного запроса');
  assert.match(errors[0], new RegExp(DROP_SNAPSHOT_VARIABLE));
});

test('отказ по вертикали через обёртку снятия снимка тоже не роняет приложение', async () => {
  const fake = fakePool(dropReply({ tenant: { rows: [{ id: 1, name: 'Барбершоп Алихан', vertical: 'clinic' }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  const errors = [];
  const result = await dropResetSnapshotFromEnv({ [DROP_SNAPSHOT_VARIABLE]: VARIABLE }, { log: () => {}, error: (m) => errors.push(String(m)) });
  assert.equal(result, null);
  assert.equal(findQuery(fake, /^DELETE FROM/i).length, 0);
  assert.match(errors[0], /снимок не снят/);
});

test('переменная снятия снимка не задана - ни базы, ни ошибок', async () => {
  const fake = fakePool(dropReply());
  __setBasePoolForTests(fake);
  const errors = [];
  assert.equal(await dropResetSnapshotFromEnv({}, { log: () => {}, error: (m) => errors.push(m) }), null);
  assert.equal(await dropResetSnapshotFromEnv({ [DROP_SNAPSHOT_VARIABLE]: '  ' }, { log: () => {}, error: (m) => errors.push(m) }), null);
  assert.equal(fake.state.queries.length, 0);
  assert.equal(errors.length, 0);
});
