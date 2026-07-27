// Тонкая API-прослойка между статическим сайтом (index.html/admin.html, GitHub Pages)
// и реальной базой Postgres на Amvera. Браузер не умеет напрямую говорить по
// протоколу Postgres - этот сервер переводит простые HTTP-запросы в SQL и обратно.
//
// Контракт нарочно минимальный: не таблицы под каждую сущность, а один
// key-value слой (kv_store), потому что storage.js на фронтенде хранит все
// записи одним JSON-блоком под одним ключом - это способ проверить саму
// синхронизацию между устройствами быстро, до перехода на полную
// нормализованную схему из плана Фазы 2 (см. plans/2026-07-26-fasa-2-final-release.md).
//
// Обязательные переменные окружения (задаются в интерфейсе Amvera при создании
// "Приложения", не хардкодятся в коде):
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD - те же, что при создании базы alikhan-crm
//   ALLOWED_ORIGIN - домен фронтенда, которому разрешено обращаться сюда (CORS)
//   PORT - опционально, порт, на котором слушает сам сервер (по умолчанию 8080)
import { createServer } from 'node:http';
import pg from 'pg';

const { Pool } = pg;

const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

// Атомарная compare-and-swap запись: advisory-лок на конкретный ключ сериализует
// все параллельные попытки записи этого же ключа (даже если строки в kv_store
// ещё не существует), поэтому две гонки с двух устройств не могут обе "победить" -
// вторая честно получит 409 и должна перечитать состояние заново (см. storage.js).
async function casWrite(key, expected, value) {
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

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['kv', ':key'] или ['kv', ':key', 'cas']

  try {
    if (url.pathname === '/health') {
      await pool.query('SELECT 1');
      return sendJson(res, 200, { ok: true });
    }

    if (parts[0] === 'kv' && parts[1] && !parts[2]) {
      const key = decodeURIComponent(parts[1]);

      if (req.method === 'GET') {
        const result = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
        if (result.rows.length === 0) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { value: result.rows[0].value });
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.value !== 'string') return sendJson(res, 400, { error: 'value_required' });
        await pool.query(
          `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, body.value]
        );
        return sendJson(res, 200, { ok: true });
      }
    }

    if (parts[0] === 'kv' && parts[1] && parts[2] === 'cas' && req.method === 'POST') {
      const key = decodeURIComponent(parts[1]);
      const body = await readBody(req);
      if (typeof body.value !== 'string') return sendJson(res, 400, { error: 'value_required' });
      const result = await casWrite(key, body.expected ?? null, body.value);
      if (!result.ok) return sendJson(res, 409, { error: 'conflict' });
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'route_not_found' });
  } catch (err) {
    console.error('Ошибка обработки запроса:', err);
    sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(PORT, () => {
  console.log(`API alikhan-crm слушает порт ${PORT}`);
});
