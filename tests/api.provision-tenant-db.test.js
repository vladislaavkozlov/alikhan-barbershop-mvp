// Окно 69, фаза 2 (26.08.2026, plans/2026-08-26-podklyuchenie-arendatora.md).
// Заведение арендатора в базе. Тесты написаны ДО кода и держат обещания фазы:
//   - идемпотентность: домен уже занят - ни одной записи, PIN не сбрасывается;
//   - fail-closed: сбой на любом шаге откатывает всё, половины арендатора нет;
//   - явный tenant_id в каждой вставке. Умолчание колонки - current_setting
//     ('app.tenant_id'), а в служебном контексте там '*', и вставка без явного
//     значения упала бы (миграция 057);
//   - опечатка в переменной не роняет приложение: живой салон Алихана не должен
//     ложиться из-за кривого JSON, относящегося к другому клиенту.
// Настоящий Postgres здесь не нужен - под db.js подставляется поддельный пул,
// записывающий запросы. Живой прогон на настоящей базе - отдельная фаза.
import assert from 'node:assert/strict';
import test from 'node:test';
import { __setBasePoolForTests } from '../api/lib/db.js';
import { parseTenantSpec } from '../api/lib/provision-tenant.js';
import { provisionTenant, provisionTenantFromEnv } from '../api/lib/provision-tenant.js';

const SPEC = parseTenantSpec(JSON.stringify({
  name: 'Урбашевичус - клиника авторской ортодонтии',
  domains: ['crm.karinaurbashevichus.ru'],
  vertical: 'clinic',
  owner: { name: 'Карина Урбашевичус', email: 'karina@urbashevichus.ru', pin: '482913' },
  services: [
    { name: 'Консультация', durationMin: 30, price: 0 },
    { name: 'Повторный сеанс', durationMin: 30, price: 0 },
  ],
}));

// Поддельный пул по образцу tests/api.tenant-context.test.js. reply - функция,
// решающая, что вернуть на очередной запрос (или бросить, чтобы проверить откат).
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

const collector = (rows = {}) => (sql) => {
  if (/^SELECT id, name FROM tenants/i.test(sql)) return rows.existing ?? { rows: [], rowCount: 0 };
  if (/^INSERT INTO tenants/i.test(sql)) return { rows: [{ id: 2 }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};

const silent = () => ({ log: () => {}, error: () => {} });
const sqlsOf = (fake) => fake.state.queries.map((q) => q.sql);
const findQuery = (fake, re) => fake.state.queries.filter((q) => re.test(q.sql));

test.afterEach(() => __setBasePoolForTests(null));

test('арендатор заводится одной транзакцией в служебном контексте', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const result = await provisionTenant(SPEC, silent());

  const sqls = sqlsOf(fake);
  assert.equal(sqls[0], 'BEGIN');
  assert.match(sqls[1], /set_config\('app\.tenant_id'/);
  // Служебный контекст: строка справочника создаётся ДО того, как арендатор
  // существует, и никаким конкретным арендатором быть не может
  assert.deepEqual(fake.state.queries[1].params, ['*']);
  assert.equal(sqls.at(-1), 'COMMIT');
  assert.equal(fake.state.live, 0, 'соединение возвращено в пул');
  assert.equal(result.created, true);
  assert.equal(result.tenantId, 2);
});

test('порядок вставок: справочник, владелец, процедуры, привязки', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await provisionTenant(SPEC, silent());
  const inserts = sqlsOf(fake).filter((s) => /^INSERT INTO/i.test(s)).map((s) => s.split(/\s+/)[2]);
  assert.deepEqual(inserts, ['tenants', 'staff', 'services', 'master_services', 'services', 'master_services']);
});

test('в каждой вставке арендатор проставлен ЯВНО - умолчание колонки в служебном контексте упало бы', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await provisionTenant(SPEC, silent());
  for (const q of findQuery(fake, /^INSERT INTO (staff|services|master_services)/i)) {
    assert.match(q.sql, /tenant_id/, `вставка без явного арендатора: ${q.sql}`);
    assert.ok(q.params.includes(2), `арендатор не передан параметром: ${q.sql}`);
  }
});

test('владелец создаётся владельцем: роль owner, временный PIN, защита от разжалования', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await provisionTenant(SPEC, silent());
  const [staff] = findQuery(fake, /^INSERT INTO staff/i);
  assert.match(staff.sql, /must_change_pin/);
  assert.match(staff.sql, /protected_owner/);
  // Роль вписана в SQL литералом, а не параметром: она не приезжает из переменной
  // и не может быть подменена заявкой ни при каких условиях
  assert.match(staff.sql, /'owner'/, 'роль владельца');
  assert.ok(!staff.params.includes('admin') && !staff.params.includes('master'), 'роль не приходит параметром');
  assert.ok(staff.params.includes('karina@urbashevichus.ru'), 'почта-логин');
  // PIN уходит в базу только хэшем - формат scrypt "соль:хэш", как у всех остальных
  assert.ok(staff.params.some((p) => typeof p === 'string' && /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(p)), 'PIN хранится хэшем');
  assert.ok(!staff.params.includes('482913'), 'сам PIN в базу не кладётся');
});

test('заданный в переменной PIN не возвращается наружу, сгенерированный - возвращается один раз', async () => {
  __setBasePoolForTests(fakePool(collector()));
  const given = await provisionTenant(SPEC, silent());
  assert.equal(given.temporaryPin, null, 'PIN задан руками - печатать его в лог незачем');

  const generated = parseTenantSpec(JSON.stringify({
    name: 'Клиника', domains: ['crm.example.ru'], vertical: 'clinic',
    owner: { name: 'К', email: 'k@example.ru' },
  }));
  __setBasePoolForTests(fakePool(collector()));
  const auto = await provisionTenant(generated, silent());
  assert.match(String(auto.temporaryPin), /^\d{6}$/);
});

test('домен уже занят - ни одной записи, PIN не сброшен', async () => {
  const fake = fakePool(collector({ existing: { rows: [{ id: 1, name: 'Барбершоп Алихан' }], rowCount: 1 } }));
  __setBasePoolForTests(fake);
  const result = await provisionTenant(SPEC, silent());
  assert.equal(result.created, false);
  assert.equal(result.tenantId, 1);
  assert.equal(findQuery(fake, /^INSERT INTO/i).length, 0, 'при занятом домене не пишется ничего');
});

test('поиск занятого домена ищет ПЕРЕСЕЧЕНИЕ списков - чужой домен нельзя увести новому арендатору', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  await provisionTenant(SPEC, silent());
  const [lookup] = findQuery(fake, /^SELECT id, name FROM tenants/i);
  assert.match(lookup.sql, /&&/, 'проверяются все домены заявки разом, а не первый');
  assert.deepEqual(lookup.params, [['crm.karinaurbashevichus.ru']]);
});

test('сбой на последнем шаге откатывает всё - половины арендатора не остаётся', async () => {
  const fake = fakePool((sql) => {
    if (/^INSERT INTO master_services/i.test(sql)) throw new Error('база отказала');
    return collector()(sql);
  });
  __setBasePoolForTests(fake);
  await assert.rejects(() => provisionTenant(SPEC, silent()), /база отказала/);
  const sqls = sqlsOf(fake);
  assert.ok(sqls.includes('ROLLBACK'), 'транзакция откатана');
  assert.ok(!sqls.includes('COMMIT'), 'ничего не зафиксировано');
  assert.equal(fake.state.live, 0, 'соединение возвращено в пул даже при сбое');
});

test('опечатка в переменной не роняет приложение: ошибка в лог, заведения нет', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const errors = [];
  const result = await provisionTenantFromEnv({ NEW_TENANT: '{битый JSON}' }, { log: () => {}, error: (m) => errors.push(String(m)) });
  assert.equal(result, null);
  assert.equal(fake.state.queries.length, 0, 'в базу не ушло ни одного запроса');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /NEW_TENANT/);
});

test('сбой базы при заведении тоже не роняет приложение', async () => {
  const fake = fakePool((sql) => {
    if (/^INSERT INTO tenants/i.test(sql)) throw new Error('база отказала');
    return collector()(sql);
  });
  __setBasePoolForTests(fake);
  const errors = [];
  const result = await provisionTenantFromEnv({ NEW_TENANT: JSON.stringify({
    name: 'Клиника', domains: ['crm.example.ru'], vertical: 'clinic',
    owner: { name: 'К', email: 'k@example.ru' },
  }) }, { log: () => {}, error: (m) => errors.push(String(m)) });
  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /база отказала/);
});

test('переменная не задана - тишина: ни базы, ни ошибок', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const errors = [];
  assert.equal(await provisionTenantFromEnv({}, { log: () => {}, error: (m) => errors.push(m) }), null);
  assert.equal(await provisionTenantFromEnv({ NEW_TENANT: '' }, { log: () => {}, error: (m) => errors.push(m) }), null);
  assert.equal(fake.state.queries.length, 0);
  assert.equal(errors.length, 0);
});

test('в лог уходит подтверждение, но не PIN, заданный руками', async () => {
  __setBasePoolForTests(fakePool(collector()));
  const lines = [];
  await provisionTenantFromEnv({ NEW_TENANT: JSON.stringify({
    name: 'Урбашевичус - клиника авторской ортодонтии',
    domains: ['crm.karinaurbashevichus.ru'],
    vertical: 'clinic',
    owner: { name: 'Карина Урбашевичус', email: 'karina@urbashevichus.ru', pin: '482913' },
  }) }, { log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) });
  const text = lines.join('\n');
  assert.match(text, /crm\.karinaurbashevichus\.ru/);
  assert.doesNotMatch(text, /482913/);
});

// ── Находка 26.08.2026, живьём в панели Amvera ────────────────────────────────
// «Значение не может содержать кавычки или восклицательный знак» - панель просто
// не принимает JSON. Поэтому та же заявка кладётся в NEW_TENANT_B64 кодировкой
// base64: ни кавычек, ни восклицательных знаков, всё так же одной строкой.
const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const KARINA_SPEC = {
  name: 'Урбашевичус - клиника авторской ортодонтии',
  domains: ['crm.karinaurbashevichus.ru'],
  vertical: 'clinic',
  owner: { name: 'Карина Урбашевичус', email: 'karina@urbashevichus.ru', pin: '112233' },
  services: [{ name: 'Консультация', durationMin: 30, price: 0 }],
};

test('заявка в base64 заводит арендатора так же, как обычная', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const result = await provisionTenantFromEnv({ NEW_TENANT_B64: b64(KARINA_SPEC) }, silent());
  assert.equal(result.created, true);
  const [tenant] = findQuery(fake, /^INSERT INTO tenants/i);
  assert.ok(tenant.params.includes('Урбашевичус - клиника авторской ортодонтии'), 'кириллица пережила кодировку');
  assert.deepEqual(tenant.params[1], ['crm.karinaurbashevichus.ru']);
});

test('битая base64 не роняет приложение и говорит, ЧТО именно не так', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const errors = [];
  const result = await provisionTenantFromEnv({ NEW_TENANT_B64: 'не-base64-вовсе' }, { log: () => {}, error: (m) => errors.push(String(m)) });
  assert.equal(result, null);
  assert.equal(fake.state.queries.length, 0);
  assert.match(errors[0], /NEW_TENANT_B64/);
});

test('обе переменные разом - отказ: непонятно, какая из них настоящая', async () => {
  const fake = fakePool(collector());
  __setBasePoolForTests(fake);
  const errors = [];
  const result = await provisionTenantFromEnv(
    { NEW_TENANT: JSON.stringify(KARINA_SPEC), NEW_TENANT_B64: b64(KARINA_SPEC) },
    { log: () => {}, error: (m) => errors.push(String(m)) }
  );
  assert.equal(result, null);
  assert.equal(fake.state.queries.length, 0, 'при двусмысленности не заводится никто');
  assert.match(errors[0], /обе/i);
});
