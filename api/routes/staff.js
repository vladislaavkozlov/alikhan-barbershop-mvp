// GET /staff, PUT /staff/:id/portfolio, PUT /staff/:id/role - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { mastersWithWorkingSchedule, filterStaffForViewer } from '../lib/schedule-core.js';

// ── /staff - роль ограничивает выдачу на уровне SQL, не только в UI ──
export async function handleStaffList(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  let query = `SELECT id, location_id, name, photo_url, phone, email, role, employed, provides_services, has_system_access,
                      experience_text, strengths_text, certificates_text, before_after_urls
               FROM staff WHERE 1=1`;
  const params = [];
  if (auth.role === 'admin') {
    params.push(auth.locationId);
    query += ` AND location_id = $${params.length}`;
  } else if (auth.role === 'master') {
    params.push(auth.id);
    query += ` AND id = $${params.length}`;
  }
  const result = await pool.query(query, params);
  const mapped = result.rows.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    name: r.name,
    photoUrl: r.photo_url,
    phone: r.phone,
    email: r.email,
    role: r.role,
    employed: r.employed,
    providesServices: r.provides_services,
    hasSystemAccess: r.has_system_access,
    // Задача 4 (Окно 13, 01.08.2026, Блок 6 в.23-26) - портфолио мастера,
    // самредактируемые владельцем поля, см. миграцию 009_staff_portfolio.sql
    experienceText: r.experience_text,
    strengthsText: r.strengths_text,
    certificatesText: r.certificates_text,
    beforeAfterUrls: r.before_after_urls,
  }));
  // Окно 22 (04.08.2026, Задача 1) - мастер без ни одной строки is_working=true в
  // master_weekly_schedule фолбэчится в getEffectiveSchedule на GLOBAL_DEFAULT
  // "10:00-20:00, без перерыва" (см. комментарий выше по файлу) - выглядит для
  // не-владельца полностью свободным, хотя физически ещё не готов принимать
  // (например только что нанят). Владелец (auth.role === 'owner') видит всех как
  // раньше + hasWorkingSchedule, чтобы сам увидел, кому нужно донастроить график -
  // остальные роли таких мастеров в ответе не получают вовсе.
  const serviceMasterIds = mapped.filter((r) => r.providesServices).map((r) => r.id);
  // Задача C промпта Окна 29 - вынесено в общую mastersWithWorkingSchedule
  // (тот же SQL, теперь единственный источник, см. комментарий там же).
  const scheduledIds = await mastersWithWorkingSchedule(pool, serviceMasterIds);
  return sendJson(res, 200, filterStaffForViewer(mapped, auth.role, scheduledIds));
}

// ── /staff/:id/portfolio - Задача 4 (Окно 13, 01.08.2026). Только владелец
// редактирует (тот же уровень доступа, что у /payroll-settings PUT - Алихан сам
// ведёт карточки сотрудников). Данных для заполнения сейчас нет (Алихан заполнит
// сам) - этот эндпоинт даёт саму возможность, не контент.
export async function handleStaffPortfolio(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  const body = await readBody(req);
  const result = await pool.query(
    `UPDATE staff SET experience_text = $1, strengths_text = $2, certificates_text = $3, before_after_urls = $4
     WHERE id = $5 RETURNING id`,
    [body.experienceText ?? null, body.strengthsText ?? null, body.certificatesText ?? null, body.beforeAfterUrls ?? null, staffId]
  );
  if (result.rows.length === 0) return sendJson(res, 404, { error: 'staff_not_found' });
  return sendJson(res, 200, { ok: true });
}

// Замок от самозапирания системы, чистая функция (инцидент 11.08.2026, см. вызов в
// handleStaffRole ниже и миграцию 043_restore_owner_role.sql). Вынесена отдельно от
// роута ровно чтобы её можно было проверить юнитами без Postgres - тот же приём, что
// у filterStaffForViewer/computeMasterPayroll ("один резолвер - одна правда").
//
// true = этот UPDATE оставил бы систему БЕЗ владельцев, значит выполнять его нельзя.
export function isLastOwnerDemotion(ownerIds, staffId, nextRole) {
  if (nextRole === 'owner') return false; // выдача роли владельцем никого не запирает
  return ownerIds.length <= 1 && ownerIds.includes(staffId);
}

// ── /staff/:id/role - Задача 1 (Окно 14, 02.08.2026). Владелец меняет роль
// сотрудника (например Мамедхан master→admin) - раньше чекбоксы роли в
// crm-owner.html были кликабельны, но физически ничего не сохраняли, эндпоинта
// не существовало вообще. Owner-only - роль решает исключительно Алихан.
export async function handleStaffRole(req, res, parts) {
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  const body = await readBody(req);
  const role = body.role;
  if (!['owner', 'admin', 'master'].includes(role)) return sendJson(res, 400, { error: 'invalid_role' });
  // Замок от самозапирания системы (инцидент 11.08.2026, миграция 043): владелец
  // сменил СЕБЕ роль на 'мастер' - и вернуть её стало некому, потому что этот самый
  // роут доступен только owner, а других владельцев на проде нет (все тестовые и
  // QA-owner вычищены миграциями 014/024/027/035/039). Починка потребовала
  // миграции, то есть деплоя - интерфейсом это было неисправимо.
  //
  // Проверяем не "меняет ли владелец себя", а более широкое условие "останется ли в
  // системе хоть один владелец": заперлись бы точно так же, если бы владелец A снял
  // роль с последнего владельца B, не трогая себя. Условие построено на СОСТОЯНИИ
  // базы, а не на auth.id, поэтому закрывает оба пути одной проверкой.
  const owners = await pool.query('SELECT id FROM staff WHERE role = $1', ['owner']);
  if (isLastOwnerDemotion(owners.rows.map((r) => r.id), staffId, role)) {
    return sendJson(res, 409, { error: 'last_owner_role_locked' });
  }
  const result = await pool.query('UPDATE staff SET role = $1 WHERE id = $2 RETURNING id, role', [role, staffId]);
  if (result.rows.length === 0) return sendJson(res, 404, { error: 'staff_not_found' });
  return sendJson(res, 200, { ok: true, id: result.rows[0].id, role: result.rows[0].role });
}
