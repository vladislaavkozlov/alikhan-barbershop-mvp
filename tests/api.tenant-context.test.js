// Фаза 1 мультиарендности (24.08.2026, plans/2026-08-24-multitenancy-etap-a.md).
// Контракт доступа к базе: каждый запрос работает внутри собственной транзакции с
// `SET LOCAL app.tenant_id`, а `pool` из api/lib/db.js отдаёт соединение именно
// этого запроса. Тесты написаны ДО кода и держат четыре обещания фазы:
//   - контекст не протекает между запросами разных арендаторов через пул (ловушка 2);
//   - запрос без арендатора падает, а не идёт на общий пул (fail-closed);
//   - вложенный BEGIN роутов переведён на точки сохранения, откат работает как раньше;
//   - долгоживущие ответы (поток событий, медиа) соединение не держат (ловушка 3).
// Настоящий Postgres здесь не нужен: проверяется контракт слоя доступа, поэтому под
// db.js подставляется поддельный пул, записывающий все запросы.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pool,
  runInTenant,
  runDetached,
  __setBasePoolForTests,
} from '../api/lib/db.js';
import { SYSTEM_TENANT, currentTenantId, DEFAULT_TENANT_ID } from '../api/lib/tenant-context.js';

// Поддельный пул: считает выданные и возвращённые соединения, копит текст запросов.
function makeFakePool() {
  const state = { connects: 0, releases: 0, live: 0, queries: [], clients: [] };
  return {
    state,
    async connect() {
      state.connects++;
      state.live++;
      const own = [];
      state.clients.push(own);
      const client = {
        async query(text, params) {
          const sql = typeof text === 'string' ? text : text?.text ?? '';
          state.queries.push({ sql, params });
          own.push(sql);
          return { rows: [], rowCount: 0, command: sql.trim().split(/\s+/)[0] };
        },
        release() {
          state.releases++;
          state.live--;
        },
      };
      return client;
    },
  };
}

function setup() {
  const fake = makeFakePool();
  __setBasePoolForTests(fake);
  return fake;
}

test.afterEach(() => __setBasePoolForTests(null));

test('запрос арендатора идёт в собственной транзакции с SET LOCAL и отпускает соединение', async () => {
  const fake = setup();
  await runInTenant(7, async () => {
    await pool.query('SELECT * FROM bookings');
  });
  const sqls = fake.state.queries.map((q) => q.sql.trim());
  assert.equal(sqls[0], 'BEGIN');
  assert.match(sqls[1], /set_config\('app\.tenant_id'/);
  assert.deepEqual(fake.state.queries[1].params, ['7']);
  assert.equal(sqls[2], 'SELECT * FROM bookings');
  assert.equal(sqls.at(-1), 'COMMIT');
  assert.equal(fake.state.connects, 1, 'на запрос берётся ровно одно соединение');
  assert.equal(fake.state.live, 0, 'соединение возвращено в пул');
});

test('контекст не протекает между запросами разных арендаторов на одном соединении', async () => {
  const fake = setup();
  await runInTenant(1, async () => {
    assert.equal(currentTenantId(), '1');
    await pool.query('SELECT 1');
  });
  await runInTenant(2, async () => {
    assert.equal(currentTenantId(), '2');
    await pool.query('SELECT 1');
  });
  const settings = fake.state.queries.filter((q) => q.sql.includes('app.tenant_id'));
  assert.deepEqual(
    settings.map((q) => q.params[0]),
    ['1', '2'],
    'каждый запрос ставит своего арендатора заново'
  );
  // Обычный SET дожил бы до конца соединения - тут его нет вообще, только set_config
  // с третьим параметром true (это и есть SET LOCAL, живущий до конца транзакции).
  for (const q of settings) assert.equal(q.params[2] ?? q.sql.includes('true'), true);
  assert.equal(fake.state.live, 0);
});

test('параллельные запросы разных арендаторов не путают контекст', async () => {
  setup();
  const seen = [];
  await Promise.all([
    runInTenant(1, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(currentTenantId());
    }),
    runInTenant(2, async () => {
      seen.push(currentTenantId());
    }),
  ]);
  assert.deepEqual(seen.sort(), ['1', '2']);
});

test('запрос без арендатора падает, а не идёт на общий пул', async () => {
  const fake = setup();
  await assert.rejects(() => pool.query('SELECT * FROM bookings'), /tenant_context_missing/);
  await assert.rejects(() => pool.connect(), /tenant_context_missing/);
  assert.equal(fake.state.connects, 0, 'ни одного соединения без арендатора не выдано');
  assert.throws(() => currentTenantId(), /tenant_context_missing/);
});

test('пустой арендатор не принимается за валидный', async () => {
  setup();
  await assert.rejects(() => runInTenant(null, async () => {}), /tenant_id/);
  await assert.rejects(() => runInTenant('', async () => {}), /tenant_id/);
  await assert.rejects(() => runInTenant(undefined, async () => {}), /tenant_id/);
});

test('вложенный BEGIN роута становится точкой сохранения, откат работает как раньше', async () => {
  const fake = setup();
  await runInTenant(1, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO bookings (id) VALUES ($1)', ['b1']);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('INSERT INTO bookings (id) VALUES ($1)', ['b2']);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
  const sqls = fake.state.queries.map((q) => q.sql.trim());
  assert.equal(fake.state.connects, 1, 'pool.connect() внутри запроса берёт то же соединение');
  assert.ok(sqls.some((s) => /^SAVEPOINT /.test(s)), 'BEGIN роута стал точкой сохранения');
  assert.ok(sqls.some((s) => /^ROLLBACK TO SAVEPOINT /.test(s)), 'откат идёт до точки сохранения');
  assert.ok(sqls.some((s) => /^RELEASE SAVEPOINT /.test(s)), 'COMMIT роута освобождает точку');
  assert.equal(sqls.filter((s) => s === 'BEGIN').length, 1, 'настоящий BEGIN один - внешний, на запрос');
  assert.equal(sqls.filter((s) => s === 'ROLLBACK').length, 0, 'внешняя транзакция не откатывается');
  assert.equal(sqls.at(-1), 'COMMIT');
});

test('вложенные друг в друга точки сохранения не пересекаются именами', async () => {
  const fake = setup();
  await runInTenant(1, async () => {
    const a = await pool.connect();
    await a.query('BEGIN');
    const b = await pool.connect();
    await b.query('BEGIN');
    await b.query('ROLLBACK');
    b.release();
    await a.query('COMMIT');
    a.release();
  });
  const names = fake.state.queries
    .map((q) => q.sql.trim())
    .filter((s) => s.startsWith('SAVEPOINT '))
    .map((s) => s.slice('SAVEPOINT '.length));
  assert.equal(new Set(names).size, names.length, 'имена точек сохранения уникальны');
});

test('ошибка внутри запроса откатывает всю транзакцию запроса', async () => {
  const fake = setup();
  await assert.rejects(
    () =>
      runInTenant(1, async () => {
        await pool.query('INSERT INTO bookings (id) VALUES ($1)', ['b1']);
        throw new Error('роут упал');
      }),
    /роут упал/
  );
  const sqls = fake.state.queries.map((q) => q.sql.trim());
  assert.equal(sqls.at(-1), 'ROLLBACK');
  assert.equal(fake.state.live, 0, 'соединение возвращено даже при ошибке');
});

test('поток живых событий не держит соединение (ловушка 3)', async () => {
  const fake = setup();
  let insideLive = null;
  await runDetached(3, async () => {
    // Так работает /events: определили арендатора, сходили в базу за личностью,
    // дальше ответ живёт часами - соединения при этом быть не должно
    await pool.query('SELECT * FROM sessions WHERE token = $1', ['t']);
    insideLive = fake.state.live;
    assert.equal(currentTenantId(), '3');
  });
  assert.equal(insideLive, 0, 'после короткого запроса соединение сразу отпущено');
  assert.equal(fake.state.connects, 1, 'соединение бралось только на сам запрос');
  assert.equal(fake.state.live, 0);
});

test('запуск миграций получает служебный контекст', async () => {
  const fake = setup();
  await runInTenant(SYSTEM_TENANT, async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key)');
  });
  const setting = fake.state.queries.find((q) => q.sql.includes('app.tenant_id'));
  assert.equal(setting.params[0], '*');
});

test('арендатор Алихана - номер 1', () => {
  assert.equal(DEFAULT_TENANT_ID, 1);
  assert.equal(SYSTEM_TENANT, '*');
});

// ── Контракт обвязки сервера ───────────────────────────────────────────────
// Прокси и контекст бесполезны, если запрос до них не доходит. Здесь проверяется
// сам факт обвязки в server.mjs - по исходнику, потому что поднимать HTTP с живым
// Postgres офлайн-набор не умеет и не должен.
import { readFile } from 'node:fs/promises';

const serverSource = await readFile(new URL('../api/server.mjs', import.meta.url), 'utf8');

test('каждый запрос сервера идёт внутри контекста арендатора', () => {
  // Фаза 4 заменила заглушку «всегда арендатор 1» на арендатора, найденного по
  // домену запроса. Обёртка при этом та же - контракт Фазы 1 не изменился
  assert.match(
    serverSource,
    /await runRequest\(tenant\.id, \(\) => handleRequest\(req, res, url, parts\)\)/,
    'обработка запроса обёрнута в контекст арендатора'
  );
  assert.match(serverSource, /DETACHED_ROUTES = new Set\(\['events', 'changes', 'media'\]\)/);
  assert.match(serverSource, /runInTenant\(SYSTEM_TENANT, runMigrations\)/, 'миграции идут в служебном контексте');
});

test('обработчик не проглатывает ошибку - транзакция запроса обязана откатиться', () => {
  const handlerCatch = serverSource.slice(serverSource.indexOf('async function handleRequest'));
  assert.match(handlerCatch, /if \(!res\.headersSent\) sendJson\(res, 500, \{ error: 'internal_error' \}\);\n    throw err;/);
});

test('мимо арендатора к базе не ходит никто: pg импортируется только в db.js', async () => {
  const files = [
    'api/lib/auth.js',
    'api/lib/events.js',
    'api/lib/notify-core.js',
    'api/routes/bookings.js',
    'api/routes/staff.js',
    'api/routes/schedule.js',
    'api/routes/clients.js',
    'api/routes/payroll.js',
    'api/server.mjs',
  ];
  for (const file of files) {
    const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from 'pg'/, `${file}: соединение берётся только через pool из lib/db.js`);
  }
});

test('сырой пул наружу не выдаётся - у прокси нет обходных путей', () => {
  assert.deepEqual(Object.keys(pool).sort(), ['connect', 'query']);
});
