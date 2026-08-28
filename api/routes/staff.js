// GET /staff, PUT /staff/:id/portfolio, PUT /staff/:id/role - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
import { sendJson, readBody, readRawBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { canManageStaff, canMutateProtectedOwner, guardAccountLockout, isAssignableRole } from '../lib/permissions.js';
import { hashPin } from '../lib/auth.js';
import { randomBytes } from 'node:crypto';
import { MAX_PORTFOLIO_ITEMS, removeStoredImage, saveProcessedImage } from '../lib/staff-media.js';
import { mastersWithWorkingSchedule, filterStaffForViewer } from '../lib/schedule-core.js';
import { dateColToStr } from '../lib/time.js';
// Живое обновление (17.08.2026): правка карточки видна в чужих кабинетах сразу
import { publish } from '../lib/events.js';

// ── /staff - роль ограничивает выдачу на уровне SQL, не только в UI ──
export async function handleStaffList(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  let query = `SELECT id, location_id, name, photo_url, phone, email, role, protected_owner, employed, employment_ended_at, provides_services, has_system_access, public_profile_enabled,
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
  // Порядок появления в салоне: кто заведён раньше - выше в списке команды и левее
  // в колонках дня (Влад, 13.08.2026). Без ORDER BY Postgres отдавал строки в порядке
  // физического хранения, а он меняется при каждом UPDATE - список тасовался сам по
  // себе после любой правки карточки. id второй ключ, он разбирает ничью у строк,
  // заведённых до появления created_at (см. миграцию 047).
  query += ' ORDER BY created_at, id';
  const result = await pool.query(query, params);
  const mapped = result.rows.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    name: r.name,
    photoUrl: r.photo_url,
    phone: r.phone,
    email: r.email,
    role: r.role,
    protectedOwner: r.protected_owner,
    employed: r.employed,
    // Дата увольнения (миграция 055). Отдаём строкой YYYY-MM-DD, а не Date: фронт
    // сравнивает её с датами броней, а те везде в CRM обычные строки
    employmentEndedAt: dateColToStr(r.employment_ended_at) ?? null,
    providesServices: r.provides_services,
    hasSystemAccess: r.has_system_access,
    publicProfileEnabled: r.public_profile_enabled,
    // Задача 4 (Окно 13, 01.08.2026, Блок 6 в.23-26) - портфолио мастера,
    // самредактируемые владельцем поля, см. миграцию 009_staff_portfolio.sql
    experienceText: r.experience_text,
    strengthsText: r.strengths_text,
    certificatesText: r.certificates_text,
    beforeAfterUrls: r.before_after_urls,
  }));
  const mediaRows = mapped.length
    ? await pool.query(
      `SELECT id, staff_id, kind, storage_key, sort_order
       FROM staff_media WHERE staff_id = ANY($1) ORDER BY staff_id, kind, sort_order, created_at`,
      [mapped.map((row) => row.id)]
    )
    : { rows: [] };
  const mediaByStaff = new Map();
  for (const media of mediaRows.rows) {
    if (!mediaByStaff.has(media.staff_id)) mediaByStaff.set(media.staff_id, []);
    mediaByStaff.get(media.staff_id).push({
      id: media.id,
      kind: media.kind,
      url: `/media/${media.storage_key}`,
      sortOrder: media.sort_order,
    });
  }
  for (const row of mapped) row.media = mediaByStaff.get(row.id) ?? [];
  // Окно 22 (04.08.2026, Задача 1) - мастер без ни одной строки is_working=true в
  // master_weekly_schedule фолбэчится в getEffectiveSchedule на GLOBAL_DEFAULT
  // "10:00-20:00, без перерыва" (см. комментарий выше по файлу) - выглядит для
  // не-владельца полностью свободным, хотя физически ещё не готов принимать
  // (например только что нанят). Владелец видит всех, администратор - всех своей
  // точки. Оба получают hasWorkingSchedule, чтобы сотрудник оставался виден в
  // команде, но календарь не предлагал заведомо недоступную запись.
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
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  // Витрина профиля (стаж, сильные стороны, сертификаты, тумблер показа) никого не
  // может запереть в системе - защищённый владелец редактирует её наравне со всеми.
  const target = await pool.query('SELECT protected_owner FROM staff WHERE id = $1', [staffId]);
  if (!target.rows.length) return sendJson(res, 404, { error: 'staff_not_found' });
  const body = await readBody(req);
  const result = await pool.query(
    `UPDATE staff SET experience_text = $1, strengths_text = $2, certificates_text = $3, before_after_urls = $4, public_profile_enabled = $5
     WHERE id = $6 RETURNING id`,
    [body.experienceText ?? null, body.strengthsText ?? null, body.certificatesText ?? null, body.beforeAfterUrls ?? null, body.publicProfileEnabled === true, staffId]
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

// ── Логин и пароль (Окно 72, 28.08.2026) ──
//
// До передачи системы заказчику вход был устроен так: поле называлось «Email»,
// значение обязано было выглядеть как почта, а фактически в базе лежали
// master1-test@alikhan.test … master5-test@alikhan.test - служебные заготовки,
// на которые письмо физически не дойдёт (`.test` - зарезервированная зона).
// Человек не мог ни запомнить свой логин, ни соотнести его с собой: владелец
// заходил как «master1», администратор - как «master4».
//
// Теперь логин - это обычное имя латиницей (aliovsad, renat, admin). Прежние
// значения с собачкой ОСТАЮТСЯ валидными: тот же движок обслуживает второго
// арендатора (клиника Карины) и уже выданные доступы ломать нельзя.
export function normalizeLogin(value) {
  const login = String(value ?? '').trim().toLowerCase();
  if (!login) return null;
  // Ветка совместимости: всё, что похоже на почту, принимаем как раньше.
  if (login.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login) ? login : null;
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(login) ? login : null;
}

// Старое имя оставлено алиасом: на него завязаны provision-tenant и тесты
// подключения арендатора, менять их в одном окне со сменой входа - лишний риск.
export const normalizeEmail = normalizeLogin;

// Пароль вместо шестизначного PIN (решение Влада 28.08.2026). Правило одно для
// всех ролей: минимум 6 знаков, любые символы - кто хочет, ставит себе шесть
// цифр, как раньше, и ничего не теряет. Верхняя граница - чтобы scrypt не
// считал хэш от мегабайтного тела запроса.
export const MIN_SECRET_LENGTH = 6;
export const isValidSecret = (secret) => {
  const value = String(secret ?? '');
  return value.length >= MIN_SECRET_LENGTH && value.length <= 72 && value.trim() === value;
};

// Алиас прежнего имени - см. довод у normalizeEmail выше.
export const isValidPin = isValidSecret;
export const newTemporaryPin = () => String(randomBytes(4).readUInt32BE(0) % 900000 + 100000);

export async function handleStaffCreate(req, res) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const email = normalizeLogin(body.email ?? body.login);
  const name = String(body.name ?? '').trim();
  if (!name || !email || !isAssignableRole(body.role)) return sendJson(res, 400, { error: 'invalid_staff_data' });
  const id = `staff-${randomBytes(12).toString('hex')}`;
  const temporaryPin = newTemporaryPin();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO staff (id, location_id, name, phone, email, role, employed, provides_services, has_system_access, pin_hash, must_change_pin) VALUES ($1,$2,$3,$4,$5,$6,true,$7,true,$8,true) RETURNING id, location_id, name, phone, email, role, employed, provides_services, has_system_access, must_change_pin`, [id, body.locationId ?? null, name, String(body.phone ?? '').trim() || null, email, body.role, body.providesServices === true, hashPin(temporaryPin)]);
    await client.query('COMMIT');
    const row = result.rows[0];
    return sendJson(res, 201, { staff: { id: row.id, locationId: row.location_id, name: row.name, phone: row.phone, email: row.email, role: row.role, employed: row.employed, providesServices: row.provides_services, hasSystemAccess: row.has_system_access, mustChangePin: row.must_change_pin }, temporaryPin });
  } catch (error) { await client.query('ROLLBACK'); if (error?.code === '23505') return sendJson(res, 409, { error: 'email_in_use' }); throw error; } finally { client.release(); }
}

// ── PUT /staff/:id/pin - владелец задаёт PIN любому сотруднику, включая себя ──
//
// Решение Влада 20.08.2026: менять PIN может ТОЛЬКО владелец, и сразу всем.
// До этого модель была обратной - каждый менял свой сам (PUT /auth/pin), а у
// владельца формы не было вовсе, то есть единственный человек с полным
// доступом не мог сменить себе пароль через интерфейс.
//
// Роль проверяет реестр роутов (auth: 'owner' в server.mjs) - до этого
// обработчика чужая роль не доходит. Здесь остаётся предметная часть.
//
// must_change_pin гасим здесь же. Флаг ставится в true при заведении
// сотрудника (handleStaffCreate выше), а снимался он раньше самостоятельной
// сменой. Самостоятельной смены больше нет - значит снять его может только
// эта операция, иначе баннер «вы входите по временному PIN» висел бы у
// человека вечно и снять его было бы нечем.
export async function handleStaffPinSet(req, res, parts) {
  // Дублирующая проверка роли. Гейт реестра уже не пустил бы сюда никого, кроме
  // владельца, но все соседние обработчики staff (handleStaffRole,
  // handleStaffUpdate, handleStaffPortfolio) проверяют права ещё и сами - и на
  // эндпоинте, который ЗАДАЁТ ПАРОЛЬ, выпадать из этого правила нельзя. Стоит
  // кому-то однажды поменять уровень в реестре или добавить второй путь к этому
  // обработчику - здесь всё равно останется замок.
  const auth = await authenticate(req);
  if (!requireRole(auth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = parts[1];
  const body = await readBody(req);
  const newPin = String(body.newPin ?? body.newPassword ?? '');
  if (!isValidSecret(newPin)) return sendJson(res, 400, { error: 'invalid_pin' });
  const result = await pool.query(
    'UPDATE staff SET pin_hash = $1, must_change_pin = false WHERE id = $2 RETURNING id',
    [hashPin(newPin), staffId],
  );
  if (result.rowCount === 0) return sendJson(res, 404, { error: 'staff_not_found' });
  return sendJson(res, 200, { ok: true });
}

export async function handleStaffUpdate(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  const body = await readBody(req);
  const target = await pool.query('SELECT protected_owner FROM staff WHERE id = $1', [staffId]);
  if (!target.rows.length) return sendJson(res, 404, { error: 'staff_not_found' });
  const email = normalizeLogin(body.email ?? body.login);
  if (!email || !String(body.name ?? '').trim()) return sendJson(res, 400, { error: 'invalid_staff_data' });
  // Ни владельца, ни самого себя нельзя снять с состава и отрезать от системы -
  // эти два поля форсятся, остальную карточку редактируют как обычно.
  // hasSystemAccess интерфейсом больше не управляется: тумблер убран 13.08.2026,
  // поэтому отсутствие поля в запросе означает "оставить как есть" (COALESCE ниже),
  // а не "включить" - иначе сохранение карточки молча возвращало бы доступ тем,
  // у кого его выключили раньше.
  // employed с 22.08.2026 живёт в своём роуте (PUT /staff/:id/employment) - тумблера
  // в карточке больше нет, увольнение стало отдельным подтверждаемым действием.
  // Поэтому отсутствие поля здесь означает «оставить как есть» (COALESCE ниже), а НЕ
  // «в штате»: со старым `body.employed !== false` любое сохранение имени или
  // телефона в карточке уволенного молча возвращало бы его в команду
  const flags = guardAccountLockout(
    { protectedOwner: target.rows[0].protected_owner, isSelf: auth.id === staffId },
    { employed: typeof body.employed === 'boolean' ? body.employed : null, hasSystemAccess: typeof body.hasSystemAccess === 'boolean' ? body.hasSystemAccess : null }
  );
  try {
    // Дата увольнения ставится и снимается САМИМ переходом флага, а не приходит из
    // тела запроса (22.08.2026). Иначе её пришлось бы слать каждым сохранением
    // карточки, и любое редактирование имени у уже уволенного человека переписывало
    // бы дату на сегодня. CASE смотрит на текущее значение колонки:
    //   работает → уволен  - ставим сегодня
    //   уволен  → работает - чистим (человека вернули в команду)
    //   без перехода       - оставляем как есть, в том числе NULL у уволенных до
    //                        миграции 055: выдумывать им дату задним числом нельзя
    const result = await pool.query(`UPDATE staff SET location_id=$1,name=$2,phone=$3,email=$4,employed=COALESCE($5,employed),provides_services=$6,has_system_access=COALESCE($7,has_system_access),
        employment_ended_at = CASE WHEN employed = true AND $5 = false THEN CURRENT_DATE WHEN $5 = true THEN NULL ELSE employment_ended_at END
      WHERE id=$8 RETURNING id,location_id,name,phone,email,role,employed,employment_ended_at,provides_services,has_system_access`, [body.locationId ?? null, String(body.name).trim(), String(body.phone ?? '').trim() || null, email, flags.employed, body.providesServices === true, flags.hasSystemAccess, staffId]);
    const row = result.rows[0];
    if (!row.employed || !row.has_system_access) await pool.query('DELETE FROM sessions WHERE staff_id = $1', [staffId]);
    // «Принимает клиентов» меняет состав колонок в расписании - шлём и staff, и
    // schedule, чтобы у соседа перестроился не только список команды, но и сетка дня
    publish('staff', { staffId, reason: 'updated' });
    publish('schedule', { staffId, reason: 'staff-updated' });
    return sendJson(res, 200, { staff: { id: row.id, locationId: row.location_id, name: row.name, phone: row.phone, email: row.email, role: row.role, employed: row.employed, employmentEndedAt: dateColToStr(row.employment_ended_at) ?? null, providesServices: row.provides_services, hasSystemAccess: row.has_system_access } });
  } catch (error) { if (error?.code === '23505') return sendJson(res, 409, { error: 'email_in_use' }); throw error; }
}

// Фото (аватар и работы) - та же витрина, что и тексты профиля: замок защищённого
// владельца сюда не относится, иначе владелец не может загрузить себе даже аватар.
async function staffMediaTarget(_auth, staffId, res) {
  const target = await pool.query('SELECT protected_owner FROM staff WHERE id = $1', [staffId]);
  if (!target.rows.length) {
    sendJson(res, 404, { error: 'staff_not_found' });
    return null;
  }
  return target.rows[0];
}

export async function handleStaffMediaUpload(req, res, parts, url) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  if (!await staffMediaTarget(auth, staffId, res)) return;
  const kind = url.searchParams.get('kind');
  if (!['avatar', 'portfolio'].includes(kind)) return sendJson(res, 400, { error: 'invalid_media_kind' });
  if (kind === 'portfolio') {
    const count = await pool.query('SELECT count(*)::int AS n FROM staff_media WHERE staff_id=$1 AND kind=$2', [staffId, kind]);
    if (count.rows[0].n >= MAX_PORTFOLIO_ITEMS) return sendJson(res, 409, { error: 'portfolio_limit' });
  }
  let saved;
  try {
    saved = await saveProcessedImage(await readRawBody(req));
    const id = `media-${randomBytes(12).toString('hex')}`;
    const client = await pool.connect();
    let replaced = [];
    try {
      await client.query('BEGIN');
      if (kind === 'avatar') {
        const old = await client.query(`DELETE FROM staff_media WHERE staff_id=$1 AND kind='avatar' RETURNING storage_key`, [staffId]);
        replaced = old.rows.map((row) => row.storage_key);
      }
      await client.query(
        `INSERT INTO staff_media (id,staff_id,kind,storage_key,sort_order)
         VALUES($1,$2,$3,$4,(SELECT coalesce(max(sort_order),0)+1 FROM staff_media WHERE staff_id=$2 AND kind=$3))`,
        [id, staffId, kind, saved.key]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    await Promise.all(replaced.map((key) => removeStoredImage(key)));
    return sendJson(res, 201, { media: { id, kind, url: `/media/${saved.key}` } });
  } catch (error) {
    if (saved) await removeStoredImage(saved.key).catch(() => {});
    return sendJson(res, error.code === 'payload_too_large' ? 413 : 400, { error: error.code === 'payload_too_large' ? 'file_too_large' : 'invalid_image' });
  }
}

export async function handleStaffMediaDelete(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  if (!await staffMediaTarget(auth, staffId, res)) return;
  const result = await pool.query('DELETE FROM staff_media WHERE staff_id=$1 AND id=$2 RETURNING storage_key', [staffId, decodeURIComponent(parts[3])]);
  if (!result.rows.length) return sendJson(res, 404, { error: 'media_not_found' });
  await removeStoredImage(result.rows[0].storage_key);
  return sendJson(res, 200, { ok: true });
}

export async function handleStaffMediaOrder(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  if (!await staffMediaTarget(auth, staffId, res)) return;
  const body = await readBody(req);
  if (!Array.isArray(body.mediaIds) || new Set(body.mediaIds).size !== body.mediaIds.length) return sendJson(res, 400, { error: 'invalid_media_order' });
  const existing = await pool.query(`SELECT id FROM staff_media WHERE staff_id=$1 AND kind='portfolio' ORDER BY sort_order`, [staffId]);
  const ids = existing.rows.map((row) => row.id);
  if (ids.length !== body.mediaIds.length || ids.some((id) => !body.mediaIds.includes(id))) return sendJson(res, 400, { error: 'invalid_media_order' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < body.mediaIds.length; i++) {
      await client.query(`UPDATE staff_media SET sort_order=$1 WHERE id=$2 AND staff_id=$3`, [i, body.mediaIds[i], staffId]);
    }
    await client.query('COMMIT');
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ── /staff/:id/role - Задача 1 (Окно 14, 02.08.2026). Владелец меняет роль
// сотрудника (например Мамедхан master→admin) - раньше чекбоксы роли в
// crm-owner.html были кликабельны, но физически ничего не сохраняли, эндпоинта
// не существовало вообще. Owner-only - роль решает исключительно Алихан.
export async function handleStaffRole(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  const body = await readBody(req);
  const role = body.role;
  if (!isAssignableRole(role)) return sendJson(res, 400, { error: 'invalid_role' });
  const target = await pool.query('SELECT id, protected_owner FROM staff WHERE id = $1', [staffId]);
  if (target.rows.length === 0) return sendJson(res, 404, { error: 'staff_not_found' });
  if (!canMutateProtectedOwner(auth, { protectedOwner: target.rows[0].protected_owner })) {
    return sendJson(res, 403, { error: 'protected_owner' });
  }
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
  publish('staff', { staffId, reason: 'role' });
  return sendJson(res, 200, { ok: true, id: result.rows[0].id, role: result.rows[0].role });
}

// ── PUT /staff/:id/employment - увольнение и возврат в команду (22.08.2026) ──────
// Отдельный роут, а не поле в общем PUT /staff/:id, по двум причинам.
// Во-первых, атомарность: увольнение обрывает сессии и убирает человека с сайта, и
// делать это заодно с сохранением имени и телефона нельзя - карточка могла содержать
// несохранённые правки полей, и «Уволить» отправляло бы их следом.
// Во-вторых, это операция, а не редактирование: у неё своё подтверждение в интерфейсе
// и свой смысл в истории.
// Строка сотрудника НЕ удаляется никогда - на неё ссылаются брони, зарплатные
// настройки и аналитика (см. миграцию 055).
export async function handleStaffEmployment(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const staffId = decodeURIComponent(parts[1]);
  const body = await readBody(req);
  if (typeof body?.employed !== 'boolean') return sendJson(res, 400, { error: 'invalid_employment' });
  const target = await pool.query('SELECT protected_owner, employed FROM staff WHERE id = $1', [staffId]);
  if (!target.rows.length) return sendJson(res, 404, { error: 'staff_not_found' });
  // Тот же замок, что и в handleStaffUpdate: владельца и себя самого уволить нельзя
  // ни тумблером, ни прямым запросом к API. Здесь это не «поправим значение молча», а
  // честный отказ - действие называется «Уволить», человек должен увидеть, что оно
  // не выполнено, а не решить, что выполнено
  const flags = guardAccountLockout(
    { protectedOwner: target.rows[0].protected_owner, isSelf: auth.id === staffId },
    { employed: body.employed }
  );
  if (flags.employed !== body.employed) return sendJson(res, 403, { error: 'employment_locked' });
  const result = await pool.query(
    `UPDATE staff SET employed = $1,
       employment_ended_at = CASE WHEN $1 = false THEN COALESCE(employment_ended_at, CURRENT_DATE) ELSE NULL END
     WHERE id = $2
     RETURNING id, name, employed, employment_ended_at`,
    [body.employed, staffId]
  );
  const row = result.rows[0];
  // Уволенному вход закрыт немедленно: открытая в соседней вкладке CRM перестаёт
  // работать на первом же запросе, а не доживает до истечения токена
  if (!row.employed) await pool.query('DELETE FROM sessions WHERE staff_id = $1', [staffId]);
  publish('staff', { staffId, reason: row.employed ? 'reinstated' : 'dismissed' });
  publish('schedule', { staffId, reason: 'staff-employment' });
  return sendJson(res, 200, { staff: { id: row.id, name: row.name, employed: row.employed, employmentEndedAt: dateColToStr(row.employment_ended_at) ?? null } });
}
