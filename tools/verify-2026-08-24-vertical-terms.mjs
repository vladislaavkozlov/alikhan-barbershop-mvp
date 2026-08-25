// Этап B, Фаза 1: словарь вертикали и флаги модулей живьём (24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// Офлайн-набор проверяет сам словарь как таблицу слов. Здесь проверяется то, чего
// он проверить не может: настоящий Postgres с миграцией 060, настоящий api/server.mjs
// и настоящий HTTP с трёх разных доменов подряд.
//
// Что доказывается:
//   1. миграция 060 кладёт флаги в справочник, у Алихана после неё не пропало ничего;
//   2. один и тот же роут отдаёт РАЗНЫЕ слова с двух доменов - главный тест окна;
//   3. незнакомая вертикаль получает барбершопные слова, а не пустой экран;
//   4. словарь доступен без входа в систему (он нужен экрану входа);
//   5. неизвестный домен получает 404, а не словарь первого попавшегося;
//   6. флаг арендатора перебивает умолчание вертикали;
//   7. словарь не протекает между арендаторами на одном соединении из пула;
//   8. в ответе нет ни названия арендатора, ни доменов, ни клиентских полей.
//
// Запуск: node tools/verify-2026-08-24-vertical-terms.mjs
import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TERMS, PHRASES } from '../api/lib/vertical-terms.js';
import { MODULE_KEYS } from '../api/lib/vertical-modules.js';
import { hashPin } from '../api/lib/auth.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'migrations');
const DB = 'vertical_terms_probe';
const ROLE = 'probe_terms_app';
const PASSWORD = 'probe';
const host = process.env.PGHOST || '/tmp';
const PORT = 9107;
const BASE = `http://127.0.0.1:${PORT}`;

// Третий арендатор - с вертикалью, которой в словаре нет. Он здесь именно ради
// критерия «незнакомая вертикаль не ломает экран»
const TENANTS = [
  { id: 1, domain: 'alikhan.test', vertical: 'barbershop', title: 'Барбершоп Алихан' },
  { id: 2, domain: 'klinika.karina.test', vertical: 'clinic', title: 'Клиника Карины', modules: { missedProfit: false } },
  { id: 3, domain: 'petshop.test', vertical: 'petshop', title: 'Зоосалон' },
];

const results = [];
async function step(name, fn) {
  await fn();
  results.push(name);
  console.log(`  ✔ ${name}`);
}

async function recreate() {
  const admin = new pg.Pool({ host, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}'`);
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  await admin.end();
}

async function asTenant(db, tenantId, sql, params = []) {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const res = await db.query(sql, params);
    await db.query('COMMIT');
    return res;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function applyMigrations(db, upTo = null) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (upTo && file > upTo) break;
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file])).rowCount) continue;
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', '*', true)");
    await db.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // поднимается
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('сервер не поднялся');
}

const appearance = (domain) =>
  fetch(`${BASE}/tenant/appearance`, { headers: domain ? { Origin: `https://${domain}` } : {} });

async function main() {
  await recreate();
  const db = new pg.Pool({ host, database: DB, user: ROLE, password: PASSWORD, max: 1 });

  // Сначала схема БЕЗ новой миграции - чтобы доказать, что 060 накатывается на
  // уже живущую базу с данными, а не только на чистую
  await applyMigrations(db, '059_tenant_domains.sql');
  await asTenant(db, '*', 'UPDATE tenants SET domains = ARRAY[$1::text] WHERE id = 1', [TENANTS[0].domain]);
  const before = await asTenant(db, '*', 'SELECT id, name, vertical, domains FROM tenants ORDER BY id');

  console.log('Словарь вертикали и флаги модулей, живой прогон:');

  await step('миграция 060 накатывается на живую базу и не трогает строку Алихана', async () => {
    await applyMigrations(db);
    const after = await asTenant(db, '*', 'SELECT id, name, vertical, domains, modules FROM tenants ORDER BY id');
    assert.equal(after.rows.length, before.rows.length, 'миграция завела или потеряла арендатора');
    for (const [i, row] of after.rows.entries()) {
      const was = before.rows[i];
      assert.equal(row.id, was.id);
      assert.equal(row.name, was.name, 'миграция переписала название арендатора');
      assert.equal(row.vertical, was.vertical, 'миграция переписала вертикаль');
      assert.deepEqual(row.domains, was.domains, 'миграция переписала домены');
      assert.deepEqual(row.modules, {}, 'умолчание флагов - пустой объект «как у моей вертикали»');
    }
  });

  await step('колонка флагов - jsonb, обязательная, с умолчанием', async () => {
    const col = await asTenant(
      db, '*',
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'tenants' AND column_name = 'modules'`
    );
    assert.equal(col.rowCount, 1, 'колонки modules нет - миграция не применилась');
    assert.equal(col.rows[0].data_type, 'jsonb');
    assert.equal(col.rows[0].is_nullable, 'NO');
    assert.match(col.rows[0].column_default, /'\{\}'::jsonb/);
  });

  await step('арендатор подключается строкой в справочнике, без новой миграции', async () => {
    for (const tenant of TENANTS.slice(1)) {
      await asTenant(
        db, '*',
        `INSERT INTO tenants (id, name, vertical, domains, modules)
         VALUES ($1, $2, $3, ARRAY[$4::text], $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET domains = EXCLUDED.domains, modules = EXCLUDED.modules`,
        [tenant.id, tenant.title, tenant.vertical, tenant.domain, JSON.stringify(tenant.modules ?? {})]
      );
    }
    const rows = await asTenant(db, '*', 'SELECT id FROM tenants ORDER BY id');
    assert.deepEqual(rows.rows.map((r) => r.id), [1, 2, 3]);
    // Владелец в каждом из двух арендаторов - чтобы проверить флаги живым запросом
    await asTenant(db, '*', "SELECT setval('locations_id_seq', GREATEST((SELECT MAX(id) FROM locations), 1))");
    for (const tenant of TENANTS.slice(0, 2)) {
      const loc = await asTenant(db, tenant.id, 'INSERT INTO locations (name) VALUES ($1) RETURNING id', [`Точка ${tenant.id}`]);
      await asTenant(
        db, tenant.id,
        `INSERT INTO staff (id, location_id, name, role, email, pin_hash, provides_services)
         VALUES ($1, $2, $3, 'owner', 'owner@shared.test', $4, true)`,
        [`staff-owner-${tenant.id}`, loc.rows[0].id, `Владелец ${tenant.id}`, hashPin('1234')]
      );
    }
  });

  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_HOST: host, DB_NAME: DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD, DB_SSL: 'disable',
      TENANT_CACHE_TTL_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  child.stdout.on('data', (d) => serverLog.push(String(d)));
  child.stderr.on('data', (d) => serverLog.push(String(d)));

  try {
    await waitForServer();

    await step('словарь отдаётся без входа в систему - он нужен экрану входа', async () => {
      const res = await appearance(TENANTS[0].domain);
      assert.equal(res.status, 200, 'словарь потребовал токен, а его на экране входа ещё нет');
    });

    await step('ГЛАВНЫЙ ТЕСТ: один роут, два домена - разные слова', async () => {
      const shop = await (await appearance(TENANTS[0].domain)).json();
      const clinic = await (await appearance(TENANTS[1].domain)).json();
      assert.equal(shop.vertical, 'barbershop');
      assert.equal(clinic.vertical, 'clinic');
      assert.equal(shop.terms.master.nomPl, 'мастера');
      assert.equal(clinic.terms.master.nomPl, 'врачи');
      assert.equal(shop.terms.client.gen, 'клиента');
      assert.equal(clinic.terms.client.gen, 'пациента');
      assert.equal(shop.phrases['booking.new'], 'Новая запись');
      assert.equal(clinic.phrases['booking.new'], 'Новый приём');
      assert.equal(shop.name, TENANTS[0].title, 'название заведения приезжает из справочника');
      assert.equal(clinic.name, TENANTS[1].title);
      assert.deepEqual(shop.terms, JSON.parse(JSON.stringify(TERMS.barbershop)));
      assert.deepEqual(clinic.phrases, PHRASES.clinic);
    });

    await step('у Алихана слова ровно те, что были до окна', async () => {
      const shop = await (await appearance(TENANTS[0].domain)).json();
      const words = JSON.stringify(shop.terms) + JSON.stringify(shop.phrases);
      for (const alien of ['врач', 'пациент', 'приём', 'процедур', 'клиник']) {
        assert.ok(!words.includes(alien), `в словаре Алихана появилось чужое слово: ${alien}`);
      }
    });

    await step('незнакомая вертикаль получает барбершопные слова, а не пустой экран', async () => {
      const petshop = await (await appearance(TENANTS[2].domain)).json();
      assert.equal(petshop.vertical, 'barbershop', 'откат вертикали не сработал');
      assert.equal(petshop.terms.master.nom, 'мастер');
      for (const key of Object.keys(TERMS.barbershop)) {
        for (const [form, value] of Object.entries(TERMS.barbershop[key])) {
          assert.equal(petshop.terms[key][form], value, `${key}.${form} потерялся при откате`);
        }
      }
    });

    await step('неизвестный домен получает 404, а не словарь первого попавшегося', async () => {
      const res = await appearance('chuzhoy.test');
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.equal(body.error, 'unknown_tenant');
      assert.ok(!('terms' in body), 'вместе с отказом уехал словарь');
    });

    await step('флаг арендатора перебивает умолчание вертикали', async () => {
      const shop = await (await appearance(TENANTS[0].domain)).json();
      const clinic = await (await appearance(TENANTS[1].domain)).json();
      assert.deepEqual(Object.keys(shop.modules).sort(), [...MODULE_KEYS].sort());
      assert.equal(shop.missedProfit, undefined);
      assert.equal(shop.modules.missedProfit, true, 'у Алихана раздел обязан остаться включённым');
      assert.equal(shop.modules.payroll, true);
      assert.equal(clinic.modules.missedProfit, false, 'значение из справочника не применилось');
      assert.equal(clinic.modules.payroll, true, 'не заданный флаг обязан взять умолчание вертикали');
    });

    await step('словарь не протекает между арендаторами на одном соединении', async () => {
      // Пул сервера общий: запросы разных доменов идут вперемешку по тем же
      // соединениям. Ловушка 2 спеки Этапа A ровно про это
      const order = [0, 1, 0, 2, 1, 1, 0, 2];
      for (const idx of order) {
        const tenant = TENANTS[idx];
        const body = await (await appearance(tenant.domain)).json();
        const expected = TERMS[tenant.vertical] ? tenant.vertical : 'barbershop';
        assert.equal(body.vertical, expected, `${tenant.domain}: приехала чужая вертикаль ${body.vertical}`);
      }
    });

    await step('в ответе только слова, флаги и название заведения - больше ничего', async () => {
      const res = await appearance(TENANTS[1].domain);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['modules', 'name', 'phrases', 'terms', 'vertical']);
      // Название добавлено осознанно (находка фазы 3): им заведение подписывается
      // перед своими же клиентами в готовых сообщениях. Секретом оно не является
      assert.equal(body.name, TENANTS[1].title);
      const raw = JSON.stringify(body);
      for (const secret of ['karina.test', 'Алихан', 'alikhan.test', '@', '+7']) {
        assert.ok(!raw.includes(secret), `наружу уехало лишнее: ${secret}`);
      }
    });

    await step('выключенный раздел не отдаёт данные и по прямому запросу к API', async () => {
      // Скрытый пункт меню защищает от промаха мышью, но не от прямого запроса -
      // ровно та же логика, что у реестра прав (Окно 33). У Алихана модуль включён,
      // у клиники «Недополученная прибыль» выключена строкой в справочнике
      const login = async (tenant) => {
        const res = await fetch(`${BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: `https://${tenant.domain}` },
          body: JSON.stringify({ email: 'owner@shared.test', pin: '1234' }),
        });
        assert.equal(res.status, 200, `${tenant.domain}: вход не прошёл`);
        return (await res.json()).token;
      };
      const call = (tenant, token, path) =>
        fetch(`${BASE}/${path}`, { headers: { Authorization: `Bearer ${token}`, Origin: `https://${tenant.domain}` } });

      const shopToken = await login(TENANTS[0]);
      const clinicToken = await login(TENANTS[1]);
      const range = 'from=2020-01-01&to=2030-12-31';
      for (const path of [`finance/missed-profit?${range}`, `finance/missed-profit/clients?${range}&kind=overdue`, 'analytics/lapsed?months=3']) {
        const shop = await call(TENANTS[0], shopToken, path);
        assert.equal(shop.status, 200, `у Алихана раздел обязан работать: ${path} → ${shop.status}`);
        const clinic = await call(TENANTS[1], clinicToken, path);
        assert.equal(clinic.status, 404, `выключенный раздел отдал данные: ${path} → ${clinic.status}`);
        assert.equal((await clinic.json()).error, 'module_disabled');
      }
      // Зарплата у клиники не выключена - обязана работать
      const payroll = await call(TENANTS[1], clinicToken, 'payroll-settings');
      assert.equal(payroll.status, 200, `невыключенный раздел отказал: ${payroll.status}`);
    });

    await step('словарь отдаётся только на чтение', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`${BASE}/tenant/appearance`, {
          method,
          headers: { Origin: `https://${TENANTS[1].domain}` },
        });
        assert.equal(res.status, 404, `${method} на словарь не должен существовать`);
      }
    });
  } finally {
    child.kill();
    await db.end();
  }

  console.log(`\nГотово: ${results.length} проверок пройдено`);
}

main().catch((err) => {
  console.error('\n✖ ПРОГОН УПАЛ:', err.message);
  process.exitCode = 1;
});
