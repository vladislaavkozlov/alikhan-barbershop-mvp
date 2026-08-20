// POST /auth/login, GET /auth/me - вынесено из server.mjs при декомпозиции (Этап 2
// структурного рефакторинга, 07.08.2026), код перенесён без изменений.
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { verifyPin, createSession, authenticate } from '../lib/auth.js';
import { notifyOwnerAboutMastersMissingSchedule } from '../lib/notify-core.js';

export async function handleLogin(req, res) {
  const body = await readBody(req);
  if (!body.email || !body.pin) return sendJson(res, 400, { error: 'email_and_pin_required' });
  const result = await pool.query(
    `SELECT id, name, role, location_id, pin_hash, must_change_pin FROM staff
     WHERE email = $1 AND employed = true AND has_system_access = true`,
    [String(body.email).toLowerCase()]
  );
  if (result.rows.length === 0) return sendJson(res, 401, { error: 'invalid_credentials' });
  const staff = result.rows[0];
  if (!verifyPin(String(body.pin), staff.pin_hash)) {
    return sendJson(res, 401, { error: 'invalid_credentials' });
  }
  const { token, expiresAt } = await createSession(staff.id);
  // Окно 35 - алерт "мастер без графика" считается при входе владельца, не
  // фоновым кроном (по решению промпта - проверки при входе достаточно). Обёрнуто
  // в try/catch: сбой этой проверки не должен ронять сам логин.
  if (staff.role === 'owner') {
    try {
      await notifyOwnerAboutMastersMissingSchedule(pool, staff.id);
    } catch (err) {
      console.error('notifyOwnerAboutMastersMissingSchedule failed:', err);
    }
  }
  return sendJson(res, 200, {
    token,
    expiresAt,
    staff: { id: staff.id, name: staff.name, role: staff.role, locationId: staff.location_id, mustChangePin: staff.must_change_pin },
  });
}

export async function handleMe(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  return sendJson(res, 200, { staff: auth });
}

// handlePinChange (самостоятельная смена своего PIN) удалён 20.08.2026 вместе с
// роутом PUT /auth/pin: по решению Влада пины задаёт только владелец, через
// PUT /staff/:id/pin (api/routes/staff.js, handleStaffPinSet).

export async function handleLogout(req, res) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : '';
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  return sendJson(res, 200, { ok: true });
}
