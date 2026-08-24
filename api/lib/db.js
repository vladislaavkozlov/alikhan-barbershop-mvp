// Пул соединений с Postgres + compare-and-swap запись поверх kv_store - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
//
// Мультиарендность, Фаза 1 (24.08.2026): `pool` здесь больше не сам пул pg, а тонкий
// прокси над ним. Он отдаёт соединение ТЕКУЩЕГО запроса - того, что открыт в
// runInTenant() с уже выставленным `app.tenant_id`. Для роутов ничего не меняется:
// `pool.query(...)` и `pool.connect()` вызываются как раньше, ни одно из 222 мест с
// SQL не переписывается. Меняется только то, откуда берётся соединение и что на нём
// уже установлено. Настоящий пул pg лежит рядом под именем basePool и наружу не
// экспортируется - обращение к базе мимо арендатора должно быть невозможно, а не
// «не принято».
import pg from 'pg';
import {
  DEFAULT_TENANT_ID,
  SYSTEM_TENANT,
  TenantContextMissingError,
  currentStore,
  currentTenantId,
  hasTenantContext,
  normalizeTenantId,
  runWithStore,
} from './tenant-context.js';

// Окно 17 (04.08.2026) - найдено живым тестом при проверке Задач 0/1/2 (не гипотеза):
// pg парсит SQL `date` (schedule_shifts.date, schedule_change_requests.date_from/
// date_to, bookings.date, clients.birthday) в JS Date как ЛОКАЛЬНУЮ полночь этого
// календарного дня. Файл в нескольких местах (GET /schedule, GET /bookings, GET/PATCH
// /schedule-requests) читает эти значения через `.toISOString().slice(0, 10)`, что
// конвертирует в UTC - если процесс Node работает не в UTC, дата съезжает на день.
// Живой репро на MSK (UTC+3): разовая правка на 2026-08-11 отображалась как
// 2026-08-10, применённый day_off на 2026-08-25 писался в БД как 2026-08-24.
// Явный пин TZ здесь превращает это в гарантию, а не предположение. Ставим ДО
// создания Pool - конструктор pg регистрирует парсеры типов один раз при первом
// использовании модуля. Декомпозиция (07.08.2026): перенесено из server.mjs в этот
// файл целиком (не оставлено разделённым между двумя файлами) - ES-модули выполняют
// import'ы раньше собственного top-level кода импортирующего файла, так что
// `process.env.TZ` обязан устанавливаться здесь же, до `new Pool(...)` ниже, иначе
// порядок относительно server.mjs не гарантирован.
process.env.TZ = 'UTC';

const { Pool } = pg;

const realPool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Amvera требует SSL, локальный Postgres в репетициях его обычно не умеет.
  // DB_SSL=disable нужен для прогонов против копии базы на своей машине (Фаза 5
  // мультиарендности: живой прогон кабинетов против копии боевой базы) - в боевом
  // окружении переменная не задаётся, и поведение остаётся прежним.
  ssl: process.env.DB_SSL === 'disable' ? false : { rejectUnauthorized: false },
});

// Подмена настоящего пула поддельным - только для офлайн-тестов контракта
// (tests/api.tenant-context.test.js). В рабочем коде вызывать нечего и незачем.
let basePool = realPool;
export function __setBasePoolForTests(fake) {
  const previous = basePool;
  basePool = fake ?? realPool;
  return previous;
}

// ── Транзакция на запрос ────────────────────────────────────────────────────
// Ловушка 2 из спеки: обычный `SET` живёт до конца СОЕДИНЕНИЯ и уезжает в следующий
// запрос другого арендатора через пул. Поэтому арендатор ставится через set_config с
// третьим аргументом true - это и есть `SET LOCAL`, действующий до конца транзакции.
// Форму с функцией, а не `SET LOCAL app.tenant_id = ...`, приходится брать потому,
// что SET не принимает параметров запроса, а склеивать значение в текст SQL - это
// дыра под инъекцию (значение приезжает из заголовка запроса, Фаза 4).
async function withTenantConnection(tenantId, fn) {
  const client = await basePool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Обработка запроса от имени арендатора: одно соединение, одна транзакция, весь код
// внутри видит её через прокси pool. Всё, что успел записать упавший обработчик,
// откатывается целиком.
export async function runInTenant(tenantId, fn) {
  const id = normalizeTenantId(tenantId);
  return withTenantConnection(id, (client) =>
    runWithStore({ tenantId: id, client, savepoints: 0, queue: Promise.resolve() }, fn)
  );
}

// Очередь запросов на соединении запроса. Найдено живым прогоном 24.08.2026: до неё
// сервер через раз отвечал «запись создана», а запись в базе не появлялась.
//
// Причина. Весь запрос теперь работает на ОДНОМ соединении, а в коде есть места, где
// несколько выборок уходят разом (Promise.all в отчётах: аналитика, зарплата,
// недополученная прибыль). Раньше каждая брала своё соединение из пула и это было
// безопасно. На одном клиенте pg такие запросы наезжают друг на друга - драйвер
// честно предупреждает «client is already executing a query», результаты разъезжаются
// по вызывающим, а транзакция запроса может уйти в откат уже ПОСЛЕ отправленного
// ответа. Клиент видит успех, данных нет.
//
// Очередь делает то, чего от пула раньше добивались параллельностью: порядок
// сохраняется, наложения нет. Плата - несколько выборок отчёта идут последовательно;
// это ожидаемая цена транзакции на запрос, отмеченная ещё в Фазе 1.
function enqueue(store, run) {
  const next = store.queue.then(run, run);
  // Хвост очереди не должен превращаться в «отклонённый промис без обработчика»:
  // ошибку получит вызывающий, а очередь идёт дальше
  store.queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// Ловушка 3 из спеки: поток живых событий (lib/events.js) держит ответ открытым
// часами, а отдача медиа читает файл с диска. Обёрнутые в транзакцию на запрос, они
// выели бы пул досуха. Здесь арендатор известен, но соединение заранее не берётся:
// каждый отдельный запрос к базе внутри (например поиск сессии в authenticate)
// открывает своё короткое соединение и тут же его отпускает.
export async function runDetached(tenantId, fn) {
  const id = normalizeTenantId(tenantId);
  return runWithStore({ tenantId: id, client: null, savepoints: 0, queue: Promise.resolve() }, fn);
}

function requireStore() {
  const store = currentStore();
  if (!store) throw new TenantContextMissingError();
  return store;
}

// Вложенные BEGIN/COMMIT/ROLLBACK роутов (10 мест в bookings.js/schedule.js/staff.js)
// внутри уже открытой транзакции запроса Postgres просто не понимает. Точки
// сохранения дают ровно прежнее поведение: частичный откат внутри запроса возможен,
// внешняя транзакция при этом жива. Роуты не переписываются - подмена происходит
// здесь, в одном месте.
function wrapAsSavepointClient(store) {
  const stack = [];
  const passthrough = (text, params) => enqueue(store, () => store.client.query(text, params));
  return {
    async query(text, params) {
      const sql = typeof text === 'string' ? text.trim().toUpperCase() : null;
      if (sql === 'BEGIN') {
        const name = `tenant_sp_${++store.savepoints}`;
        stack.push(name);
        return passthrough(`SAVEPOINT ${name}`);
      }
      if (sql === 'COMMIT') {
        const name = stack.pop();
        if (!name) return { command: 'COMMIT', rows: [], rowCount: 0 };
        return passthrough(`RELEASE SAVEPOINT ${name}`);
      }
      if (sql === 'ROLLBACK') {
        const name = stack.pop();
        if (!name) return { command: 'ROLLBACK', rows: [], rowCount: 0 };
        await passthrough(`ROLLBACK TO SAVEPOINT ${name}`);
        return passthrough(`RELEASE SAVEPOINT ${name}`);
      }
      return passthrough(text, params);
    },
    // Соединение принадлежит запросу целиком и отпускается в runInTenant - роут,
    // честно вызывающий release() в finally, не должен обрывать транзакцию соседям.
    release() {},
  };
}

// pool.connect() вне транзакции запроса (поток событий, медиа): своё соединение со
// своей короткой транзакцией, release() её завершает.
async function connectDetached(tenantId) {
  const client = await basePool.connect();
  let closed = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  } catch (err) {
    client.release();
    throw err;
  }
  return {
    query: (text, params) => client.query(text, params),
    release() {
      if (closed) return;
      closed = true;
      client
        .query('COMMIT')
        .catch(() => client.query('ROLLBACK').catch(() => {}))
        .finally(() => client.release());
    },
  };
}

// Единственная дверь к базе МИМО арендатора - и она открывается только в справочник
// tenants (миграция 058 сознательно оставила его без замка). Нужна она ровно для
// одного: определить, чей это запрос, до того как контекст арендатора вообще
// существует. Любая другая таблица через неё недоступна не по договорённости, а
// потому что замок в базе её всё равно не отдаст без контекста.
export async function registryQuery(text, params) {
  if (!/\bFROM tenants\b/i.test(text)) {
    throw new Error('registry_query_scope: эта дверь открывается только в справочник арендаторов');
  }
  return basePool.query(text, params);
}

// Безопасен ли пользователь базы для замка на уровне строк. Суперпользователь и
// роль с BYPASSRLS игнорируют политику всегда - на такой базе замок выглядел бы
// поставленным, но не держал. Проверить это снаружи нельзя: база Amvera живёт во
// внутренней сети, поэтому спрашивает само приложение (см. /health).
export async function dbRoleIsSafe() {
  const res = await basePool.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  const row = res.rows[0];
  return row ? !row.rolsuper && !row.rolbypassrls : null;
}

// Тот самый прокси. Наружу выглядит как pg.Pool ровно в той части, которой пользуется
// код проекта: .query() и .connect(). Ничего другого от пула здесь никто не просит.
export const pool = {
  async query(text, params) {
    const store = requireStore();
    if (store.client) return enqueue(store, () => store.client.query(text, params));
    return withTenantConnection(store.tenantId, (client) => client.query(text, params));
  },
  async connect() {
    const store = requireStore();
    if (store.client) return wrapAsSavepointClient(store);
    return connectDetached(store.tenantId);
  },
};

export { DEFAULT_TENANT_ID, SYSTEM_TENANT, currentTenantId, hasTenantContext };

// Атомарная compare-and-swap запись поверх kv_store - оставлена для обратной
// совместимости общего /kv/:key контракта (Окно 7), bookings им больше не пишутся.
export async function casWrite(key, expected, value) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const current = await client.query('SELECT value FROM kv_store WHERE key = $1', [key]);
    const currentValue = current.rows[0]?.value ?? null;
    if (currentValue !== (expected ?? null)) {
      await client.query('ROLLBACK');
      return { ok: false, conflict: true };
    }
    await client.query(
      `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
