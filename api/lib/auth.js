// PIN-хэш, сессии, аутентификация запроса и проверка роли - вынесено из server.mjs
// при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код перенесён
// без изменений.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { pool } from './db.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней - простой логин, не нужен рефреш-стек

// scrypt из node:crypto - без внешней зависимости (bcrypt пришлось бы ставить через
// npm install, который в песочнице ненадёжен - см. память проекта). Формат хранения:
// "saltHex:hashHex".
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const candidate = scryptSync(pin, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export async function createSession(staffId) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('INSERT INTO sessions (token, staff_id, expires_at) VALUES ($1, $2, $3)', [
    token,
    staffId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

// Возвращает { id, name, role, locationId } текущего сотрудника по Bearer-токену,
// или null (анонимный запрос - легален для GET/POST /bookings, см. ниже).
export async function authenticate(req) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return null;
  const result = await pool.query(
    `SELECT s.id, s.name, s.role, s.location_id, sess.expires_at
     FROM sessions sess JOIN staff s ON s.id = sess.staff_id
     WHERE sess.token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, name: row.name, role: row.role, locationId: row.location_id };
}

export function requireRole(auth, roles) {
  return auth && roles.includes(auth.role);
}
