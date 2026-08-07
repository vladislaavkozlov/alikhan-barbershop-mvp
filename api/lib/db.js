// Пул соединений с Postgres + compare-and-swap запись поверх kv_store - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
import pg from 'pg';

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

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

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
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
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
