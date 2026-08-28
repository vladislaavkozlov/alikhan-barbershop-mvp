// Разовое удаление тестовых сотрудников (28.08.2026, замечание владельца: «Тест Аудит»
// и «Тест Сценарии» - не уволенные люди, а следы разработки, заказчику их видеть незачем).
//
// Эта операция необратимее сброса данных: удалённого человека не вернёт ни увольнение,
// ни повторный вход, а ошибка в списке идентификаторов вычеркнет живого мастера вместе
// с его компетенциями и зарплатными настройками. Поэтому тесты держат не столько
// «удаляет что просили», сколько «отказывается удалять всё остальное»:
//   - контекст АРЕНДАТОРА, а не служебный '*';
//   - сверка названия И вертикали, как в сбросе;
//   - в штате - не трогаем: удаляются только уже уволенные;
//   - есть записи - не трогаем: история отработанных периодов важнее чистоты списка;
//   - хоть один идентификатор не найден - не трогаем НИКОГО, операция отказывает целиком;
//   - снимок в kv_store пишется ДО удаления и включает каскадные таблицы, которые иначе
//     уйдут молча;
//   - идемпотентность по метке, кривая переменная не роняет приложение.
// Настоящий Postgres здесь не нужен - под db.js подставляется поддельный пул.
import assert from 'node:assert/strict';
import test from 'node:test';
import { __setBasePoolForTests } from '../api/lib/db.js';
import {
  PURGE_STAFF_TABLES,
  PURGE_STAFF_VARIABLE,
  parsePurgeStaffSpec,
  purgeSnapshotKey,
  purgeStaff,
  purgeStaffFromEnv,
} from '../api/lib/reset-tenant-data.js';

const IDS = ['staff-be6373da1266409ee97e3ecb', 'staff-47aa89cf150efdb1ddc3de9a'];
const VARIABLE = `1:Барбершоп Алихан:testovye-sotrudniki-2026-08-28:${IDS.join(',')}`;
const SPEC = parsePurgeStaffSpec(VARIABLE);

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

// Обычный ответ базы: арендатор 1 назван как в заявке, снимка ещё нет, оба названных
// человека существуют, уволены и записей за собой не имеют
const collector = (over = {}) => (sql) => {
  if (/FROM tenants WHERE id/i.test(sql)) return over.tenant ?? { rows: [{ id: 1, name: 'Барбершоп Алихан', vertical: 'barbershop' }], rowCount: 1 };
  if (/FROM kv_store WHERE key/i.test(sql)) return over.snapshot ?? { rows: [], rowCount: 0 };
  if (/FROM staff WHERE tenant_id/i.test(sql)) {
    return over.staff ?? {
      rows: [
        { id: IDS[0], name: 'Тест Аудит', role: 'master', employed: false, email: 'team-audit@alikhan.test' },
        { id: IDS[1], name: 'Тест Сценарии', role: 'master', employed: false, email: 'team-newtests@alikhan.test' },
      ],
      rowCount: 2,
    };
  }
  if (/FROM bookings WHERE tenant_id/i.test(sql)) return over.bookings ?? { rows: [], rowCount: 0 };
  if (/^SELECT \* FROM/i.test(sql)) return { rows: [{ id: 'row-1' }], rowCount: 1 };
  if (/^DELETE FROM schedule_breaks/i.test(sql)) return { rows: [], rowCount: 1 };
  if (/^DELETE FROM/i.test(sql)) return { rows: [], rowCount: 2 };
  return { rows: [], rowCount: 0 };
};

const silent = () => ({ log: () => {}, error: () => {} });
const sqlsOf = (fake) => fake.state.queries.map((q) => q.sql);
const indexOf = (fake, re) => sqlsOf(fake).findIndex((sql) => re.test(sql));

test.afterEach(() => __setBasePoolForTests(null));

// ── Разбор переменной ───────────────────────────────────────────────────────

test('заявка разбирается на номер, название, метку и список людей', () => {
  assert.deepEqual(SPEC, {
    tenantId: 1,
    tenantName: 'Барбершоп Алихан',
    label: 'testovye-sotrudniki-2026-08-28',
    ids: IDS,
  });
});

test('переменной нет или она пуста - тишина, а не ошибка', () => {
  assert.equal(parsePurgeStaffSpec(undefined), null);
  assert.equal(parsePurgeStaffSpec(''), null);
  assert.equal(parsePurgeStaffSpec('   '), null);
});

test('кавычка и восклицательный знак отсекаются: панель Amvera такое значение не примет', () => {
  assert.throws(() => parsePurgeStaffSpec('1:"Салон":metka:staff-a'), /кавычка/);
  assert.throws(() => parsePurgeStaffSpec('1:Салон!:metka:staff-a'), /восклицательный/);
});

test('неполная заявка, нечисловой номер, пустое название и кривая метка отвергаются', () => {
  assert.throws(() => parsePurgeStaffSpec('1:Барбершоп Алихан:metka'), /не похоже на заявку/);
  assert.throws(() => parsePurgeStaffSpec('один:Салон:metka:staff-a'), /не число/);
  assert.throws(() => parsePurgeStaffSpec('1::metka:staff-a'), /название/);
  assert.throws(() => parsePurgeStaffSpec('1:Салон:метка:staff-a'), /метка/);
});

test('список людей не может быть пустым', () => {
  assert.throws(() => parsePurgeStaffSpec('1:Салон:metka:'), /не похоже на заявку|ни один сотрудник/);
  assert.throws(() => parsePurgeStaffSpec('1:Салон:metka: , '), /ни один сотрудник/);
});

test('двоеточие внутри названия не съедает часть названия', () => {
  assert.deepEqual(parsePurgeStaffSpec('2:Клиника: авторская ортодонтия:metka:staff-a,staff-b'), {
    tenantId: 2,
    tenantName: 'Клиника: авторская ортодонтия',
    label: 'metka',
    ids: ['staff-a', 'staff-b'],
  });
});

// ── Рубежи защиты ───────────────────────────────────────────────────────────

test('название арендатора не сошлось - не удаляется ничего', async () => {
  const fake = fakePool(collector({ tenant: { rows: [{ id: 1, name: 'Другой салон', vertical: 'barbershop' }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => purgeStaff(SPEC, silent()), /называется/);
  assert.equal(indexOf(fake, /^DELETE FROM/i), -1);
});

test('вертикаль не барбершоп - не удаляется ничего, даже если имя сошлось', async () => {
  const fake = fakePool(collector({ tenant: { rows: [{ id: 2, name: 'Барбершоп Алихан', vertical: 'clinic' }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => purgeStaff(SPEC, silent()), /вертикаль/);
  assert.equal(indexOf(fake, /^DELETE FROM/i), -1);
});

test('арендатора в базе нет - не удаляется ничего', async () => {
  const fake = fakePool(collector({ tenant: { rows: [], rowCount: 0 } }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => purgeStaff(SPEC, silent()), /в базе нет/);
  assert.equal(indexOf(fake, /^DELETE FROM/i), -1);
});

test('хоть один идентификатор не найден - не удаляется НИКТО, включая найденных', async () => {
  const fake = fakePool(collector({
    staff: { rows: [{ id: IDS[0], name: 'Тест Аудит', role: 'master', employed: false, email: null }], rowCount: 1 },
  }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => purgeStaff(SPEC, silent()), /этих сотрудников/);
  assert.equal(indexOf(fake, /^DELETE FROM/i), -1);
  assert.equal(indexOf(fake, /INSERT INTO kv_store/i), -1);
});

test('человек числится в штате - операция отказывает целиком', async () => {
  const fake = fakePool(collector({
    staff: {
      rows: [
        { id: IDS[0], name: 'Тест Аудит', role: 'master', employed: false, email: null },
        { id: IDS[1], name: 'Ренат', role: 'master', employed: true, email: null },
      ],
      rowCount: 2,
    },
  }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => purgeStaff(SPEC, silent()), /числятся в штате/);
  assert.equal(indexOf(fake, /^DELETE FROM/i), -1);
});

test('за человеком числятся записи - операция отказывает целиком', async () => {
  const fake = fakePool(collector({ bookings: { rows: [{ master_id: IDS[1], n: 4 }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  await assert.rejects(() => purgeStaff(SPEC, silent()), /числятся записи/);
  assert.equal(indexOf(fake, /^DELETE FROM/i), -1);
});

// ── Удачный ход ─────────────────────────────────────────────────────────────

test('операция идёт в контексте арендатора, а не в служебном', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await purgeStaff(SPEC, silent());
  const ctx = fake.state.queries.filter((q) => /set_config\('app.tenant_id'/i.test(q.sql));
  assert.ok(ctx.length > 0, 'контекст арендатора обязан выставляться');
  assert.ok(ctx.every((q) => !String(q.params?.[0] ?? q.sql).includes('*')), 'служебный контекст здесь недопустим');
});

test('снимок для отката пишется ДО первого удаления', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await purgeStaff(SPEC, silent());
  const snapshotAt = indexOf(fake, /INSERT INTO kv_store/i);
  const firstDelete = indexOf(fake, /^DELETE FROM/i);
  assert.ok(snapshotAt >= 0 && firstDelete >= 0);
  assert.ok(snapshotAt < firstDelete, 'снимок после удаления пуст по построению');
});

test('в снимок попадают и каскадные таблицы: иначе они уйдут молча', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await purgeStaff(SPEC, silent());
  const insert = fake.state.queries.find((q) => /INSERT INTO kv_store/i.test(q.sql));
  const value = JSON.parse(insert.params[2]);
  for (const table of [...PURGE_STAFF_TABLES, 'schedule_breaks', 'staff_media', 'notifications', 'sessions', 'staff']) {
    assert.ok(table in value.tables, `в снимке нет таблицы ${table}`);
  }
  assert.deepEqual(value.ids, IDS);
});

test('сотрудник удаляется ПОСЛЕ всего, что на него ссылается', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await purgeStaff(SPEC, silent());
  const staffAt = indexOf(fake, /^DELETE FROM staff WHERE/i);
  for (const table of [...PURGE_STAFF_TABLES, 'schedule_breaks']) {
    const at = indexOf(fake, new RegExp(`^DELETE FROM ${table}`, 'i'));
    assert.ok(at >= 0 && at < staffAt, `${table} обязана чиститься до самой staff`);
  }
});

test('каждое удаление несёт явное условие по арендатору и по списку людей', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await purgeStaff(SPEC, silent());
  for (const q of fake.state.queries.filter((x) => /^DELETE FROM/i.test(x.sql))) {
    assert.match(q.sql, /tenant_id = \$1/, `нет условия по арендатору: ${q.sql}`);
    assert.match(q.sql, /ANY\(\$2::text\[\]\)/, `нет условия по списку людей: ${q.sql}`);
  }
});

test('перерывы чистятся через свои смены и раньше смен: у них нет колонки master_id', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await purgeStaff(SPEC, silent());
  const breaksAt = indexOf(fake, /^DELETE FROM schedule_breaks/i);
  const shiftsAt = indexOf(fake, /^DELETE FROM schedule_shifts/i);
  assert.ok(breaksAt >= 0 && shiftsAt >= 0);
  assert.ok(breaksAt < shiftsAt, 'перерыв держит внешний ключ на смену, значит уходит первым');
  const sql = sqlsOf(fake)[breaksAt];
  assert.match(sql, /shift_id IN \(SELECT id FROM schedule_shifts/, 'привязка перерыва идёт через смену');
  assert.doesNotMatch(sql, /schedule_breaks\s+WHERE\s+tenant_id = \$1\s+AND master_id/, 'колонки master_id у перерыва нет');
});

test('повторный старт с той же меткой не удаляет ничего', async () => {
  const fake = fakePool(collector({ snapshot: { rows: [{ updated_at: '2026-08-28T10:00:00Z' }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  const res = await purgeStaff(SPEC, silent());
  assert.equal(res.applied, false);
  assert.equal(indexOf(fake, /^DELETE FROM/i), -1);
});

test('ключ снимка отличается от ключа сброса данных: две операции не мешают друг другу', () => {
  assert.equal(purgeSnapshotKey('metka'), 'staff-purge:metka');
});

// ── Точка входа ─────────────────────────────────────────────────────────────

test('кривая переменная не роняет приложение', async () => {
  const said = [];
  const res = await purgeStaffFromEnv({ [PURGE_STAFF_VARIABLE]: 'мусор' }, { log: () => {}, error: (m) => said.push(m) });
  assert.equal(res, null);
  assert.ok(said.length > 0, 'о причине отказа обязано быть сказано вслух');
});

test('переменной нет - точка входа молчит и ничего не делает', async () => {
  const said = [];
  const res = await purgeStaffFromEnv({}, { log: () => {}, error: (m) => said.push(m) });
  assert.equal(res, null);
  assert.equal(said.length, 0);
});

test('отказ базы не роняет приложение и не оставляет полуудаления', async () => {
  const fake = fakePool((sql) => {
    if (/^DELETE FROM master_weekly_schedule/i.test(sql)) throw new Error('база отказала');
    return collector()(sql);
  });
  __setBasePoolForTests(fake);
  const said = [];
  const res = await purgeStaffFromEnv({ [PURGE_STAFF_VARIABLE]: VARIABLE }, { log: () => {}, error: (m) => said.push(m) });
  assert.equal(res, null);
  assert.ok(said.some((m) => /в базе ничего не изменено/i.test(m)));
  assert.equal(fake.state.live, 0, 'соединение обязано быть отпущено');
});
