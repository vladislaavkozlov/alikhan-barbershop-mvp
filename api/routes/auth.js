// POST /auth/login, GET /auth/me - вынесено из server.mjs при декомпозиции (Этап 2
// структурного рефакторинга, 07.08.2026), код перенесён без изменений.
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { verifyPin, createSession, authenticate } from '../lib/auth.js';
import { clientIp, registerFailure, registerSuccess, retryAfterSeconds } from '../lib/login-throttle.js';
import { normalizeLogin } from './staff.js';

// Вход по логину и паролю (Окно 72, 28.08.2026). Ключи запроса приняты в двух
// написаниях: новый фронт шлёт { login, password }, а старая вкладка, открытая
// до выкатки, ещё какое-то время будет слать { email, pin } - ломать её незачем.
// Логин ищется в пределах текущего арендатора: замок базы (миграция 058) не
// покажет этому запросу чужие строки, поэтому короткое имя вроде «admin» может
// существовать у каждого арендатора отдельно.
export async function handleLogin(req, res) {
  const body = await readBody(req);
  const rawLogin = body.login ?? body.email;
  const secret = body.password ?? body.pin;
  if (!rawLogin || !secret) return sendJson(res, 400, { error: 'email_and_pin_required' });
  const login = normalizeLogin(rawLogin) ?? String(rawLogin).trim().toLowerCase();
  const ip = clientIp(req);

  // Пара «логин + адрес» в паузе после пяти промахов подряд - до базы не идём.
  const waitSeconds = retryAfterSeconds(login, ip);
  if (waitSeconds !== null) {
    res.setHeader('Retry-After', String(waitSeconds));
    return sendJson(res, 429, { error: 'too_many_attempts', retryAfter: waitSeconds });
  }

  const result = await pool.query(
    `SELECT id, name, role, location_id, pin_hash, must_change_pin FROM staff
     WHERE email = $1 AND employed = true AND has_system_access = true`,
    [login]
  );
  if (result.rows.length === 0) {
    registerFailure(login, ip);
    return sendJson(res, 401, { error: 'invalid_credentials' });
  }
  const staff = result.rows[0];
  if (!verifyPin(String(secret), staff.pin_hash)) {
    registerFailure(login, ip);
    return sendJson(res, 401, { error: 'invalid_credentials' });
  }
  registerSuccess(login, ip);
  const { token, expiresAt } = await createSession(staff.id);
  // Уведомление "у мастера пропал график" (Окно 35) снято 20.08.2026 вместе с
  // остальными не-записевыми типами: лента теперь только про записи клиентов, а
  // сам источник инцидента исчез - график правит только владелец/администратор,
  // мастер не может ни сменить его, ни попросить отгул через CRM.
  // Расчёт «у кого нет рабочего графика» сохранился и продолжает работать в разделе
  // «Клиенты» (api/routes/clients.js) - потеряно уведомление, не проверка.
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
