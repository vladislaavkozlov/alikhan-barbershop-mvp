import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate } from '../lib/auth.js';

// Точки нужны редактору сотрудника только как справочник. Администратор и мастер
// получают лишь свою точку, чтобы список не раскрывал структуру чужого филиала
export async function handleLocationsList(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  const result = auth.role === 'owner' || auth.role === 'manager'
    ? await pool.query('SELECT id, name, address FROM locations ORDER BY id')
    : await pool.query('SELECT id, name, address FROM locations WHERE id = $1', [auth.locationId]);
  return sendJson(res, 200, result.rows.map((row) => ({ id: row.id, name: row.name, address: row.address })));
}
