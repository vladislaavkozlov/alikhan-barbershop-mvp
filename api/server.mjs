// Тонкая API-прослойка между статическим сайтом (index.html/admin.html, GitHub Pages)
// и реальной базой Postgres на Amvera. Браузер не умеет напрямую говорить по
// протоколу Postgres - этот сервер переводит простые HTTP-запросы в SQL и обратно.
//
// Окно 8 (27.07.2026): нормализованная схема (миграция 002_schema.sql) заменила
// временный kv_store (Окно 7) как источник истины для bookings/staff/services и т.д.
// /kv/:key остаётся - старый общий контракт, ничего не удаляет и не ломает, просто
// bookings теперь не через него.
//
// Обязательные переменные окружения (задаются в интерфейсе Amvera при создании
// "Приложения", не хардкодятся в коде):
//   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD - те же, что при создании базы alikhan-crm
//   ALLOWED_ORIGIN - домен фронтенда, которому разрешено обращаться сюда (CORS)
//   PORT - опционально, порт, на котором слушает сам сервер (по умолчанию 8080)
import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setCors, sendJson, createBufferedResponse } from './lib/http.js';
import { pool, runInTenant, runDetached, registryQuery, dbRoleIsSafe } from './lib/db.js';
import { SYSTEM_TENANT } from './lib/tenant-context.js';
import { resolveTenantForRequest, corsOriginFor } from './lib/tenants.js';
import { authenticate, requireRole } from './lib/auth.js';
import { canManageStaff } from './lib/permissions.js';
// Ре-экспорт для tests/*.test.js, которые импортируют эти имена напрямую из
// server.mjs (in-memory юниты без реального Postgres) - не используются в самом
// server.mjs напрямую (все роуты, которые их вызывали, переехали в routes/*.js).
export {
  getEffectiveSchedule,
  filterStaffForViewer,
  mastersWithWorkingSchedule,
  hasAvailableSlot,
  isScheduleDayOff,
  SCHEDULE_RANGE_MAX_DAYS,
  rangeDayCount,
  computeScheduleRangeDays,
  SCHEDULE_AVAILABILITY_MAX_DAYS,
  computeAvailabilityRangeDays,
  MASTER_NEXT_AVAILABILITY_WINDOW_DAYS,
  computeMasterNextAvailability,
  findWeeklyScheduleConflicts,
  findScheduleConflicts,
  listHolidays,
  holidayCloseTargets,
  fullDayOffWindow,
  dayOffWindowsForRequest,
  planHolidayClose,
  HOLIDAY_CLOSE_MAX_DAYS,
} from './lib/schedule-core.js';
import { addSubscriber, changesSnapshot, subscriberCount } from './lib/events.js';
export { findMastersMissingSchedule } from './lib/notify-core.js';
// Ре-экспорт для tests/*.test.js, которые импортируют эти имена напрямую из
// server.mjs (in-memory юниты без реального Postgres) - см. правило 6 плана
// декомпозиции, plans/2026-08-07-server-mjs-decomposition.md.
export { isoWeekday, enumerateDateRange } from './lib/time.js';
import { handleLogin, handleLogout, handleMe } from './routes/auth.js';
import { handleStaffCreate, handleStaffEmployment, handleStaffList, handleStaffMediaDelete, handleStaffMediaOrder, handleStaffMediaUpload, handleStaffPinSet, handleStaffPortfolio, handleStaffRole, handleStaffUpdate } from './routes/staff.js';
import { MEDIA_ROOT } from './lib/staff-media.js';
import { handlePublicMasters } from './routes/public-masters.js';
import { handleLocationsList } from './routes/locations.js';
// Ре-экспорт для tests/api.staff-role-lock.test.js (инцидент 11.08.2026).
export { isLastOwnerDemotion } from './routes/staff.js';
import { handleServicesList, handleMasterServicesList, handleMasterServiceUpdate } from './routes/services.js';
import { handleBookings, handleBookingCancel, handleBookingStatus, handleBookingAddServices, handleBookingSetServices, handleBookingReschedule, handleBookingActualPrice, handleBookingClient, handleBookingDelete, handleSales } from './routes/bookings.js';
// Ре-экспорт для tests/api.booking-reschedule.test.js (Окно 54, Задача B и C).
export { checkSlotAvailability, resolveRescheduleDuration, planRescheduleNotifications, formatMoveSlot, normalizeStaffComment, BOOKING_COMMENT_MAX_LEN, resolveServicesReplacement, normalizeClientName, normalizeClientPhoneInput, CLIENT_NAME_MAX_LEN, normalizeClientSource, firstBookingIdByClient, CLIENT_SOURCE_KEYS } from './routes/bookings.js';
import {
  handleSchedule,
  handleScheduleExceptions,
  handleScheduleRange,
  handleHolidaysList,
  handleHolidaysClose,
  handleScheduleAvailability,
  handleMastersNextAvailability,
  handleMasterWeeklySchedule,
} from './routes/schedule.js';
import {
  handleNotificationsList,
  handleNotificationsUnreadCount,
  handleNotificationRead,
  handleNotificationDismiss,
  handleNotificationsReadAll,
} from './routes/notifications.js';
import { handlePayrollSettings, handlePayroll, handleRevenueToday, handleDiscountSettings } from './routes/payroll.js';
import { handleOwnerAlerts, handleClientsAtRisk, handleClientCard, handleClientRenew } from './routes/clients.js';
// Раздел «Аналитика» владельца (22.08.2026) - возвращаемость по мастерам и каналы
// привлечения. Считает по уже существующим полям броней, своих таблиц не заводит.
import { handleAnalyticsRetention, handleAnalyticsSources, handleAnalyticsLapsed, handleAnalyticsUnlinked, handleAnalyticsRenewDiscussed } from './routes/analytics.js';
import { handleMissedProfit, handleMissedProfitClients } from './routes/missed-profit.js';
// Своя резервная копия базы (24.08.2026) - см. подробный комментарий в самом файле
import { handleBackup } from './routes/backup.js';
// Ре-экспорт для tests/*.test.js.
export { describeClientRisk, getClientCard, listClientsAtRisk, computeOwnerAlerts } from './routes/clients.js';
export { percentOf, shapeSourceRows, parseMonths, RETENTION_MONTHS, SOURCE_MONTHS } from './routes/analytics.js';
export { computeLapsedClients, computeUnlinkedVisits, computeRenewDiscussed } from './routes/analytics.js';
export { computeMissedProfit, isDateStr } from './routes/missed-profit.js';
export { normalizePhoneKey, findClientByPhone, resolveClientsQueryMode, shapeClientCardForViewer, listAllClients, summarizeClientVisits } from './routes/clients.js';
export { computeMasterPayroll, computeRevenueToday, countUnidentifiedToday } from './routes/payroll.js';

const PORT = Number(process.env.PORT) || 8080;

// ── Окно 33 (06.08.2026), Задача C: реестр роутов default-deny ─────────────
// Ровно та дыра, которую эксплуатировали /kv/:key (Задача A этого же окна) -
// роут существовал в if/else ниже без единой проверки auth. Реестр делает
// авторизацию декларативной и обязательной: у каждого роута явное поле auth,
// 'public' - осознанное решение, не отсутствие проверки. Роут без записи здесь
// получает 404 РАНЬШЕ, чем дойдёт до if/else - забыть зарегистрировать новый
// роут теперь равносильно "роута не существует", а не "существует без проверки".
//
// 'owner' - реестр сам требует роль owner до обработчика. 'any-staff' - реестр
// требует любой валидный токен (роль не сужена); более узкое требование
// конкретного роута (только admin+owner, только master и т.п.) как и раньше
// проверяет свой requireRole() внутри обработчика - реестр его не заменяет,
// только гарантирует, что аноним до этой проверки вообще не дойдёт.
const ROUTES = [
  { method: 'GET', path: 'health', auth: 'public' },
  { method: 'POST', path: 'auth/login', auth: 'public' },
  { method: 'GET', path: 'auth/me', auth: 'any-staff' },
  // PUT /auth/pin (самостоятельная смена своего PIN) снят 20.08.2026 по решению
  // Влада: пины задаёт только владелец, через PUT /staff/:id/pin ниже. Роут убран
  // из реестра, значит запрос к нему получает 404 на гейте и до обработчика не
  // доходит - оставлять его живым «на всякий случай» нельзя, это была бы обходная
  // дверь мимо нового правила.
  { method: 'POST', path: 'auth/logout', auth: 'public' },
  { method: 'GET', path: 'staff', auth: 'any-staff' },
  { method: 'GET', path: 'locations', auth: 'any-staff' },
  { method: 'POST', path: 'staff', auth: 'management' },
  { method: 'PUT', path: 'staff/:id', auth: 'management' },
  { method: 'POST', path: 'staff/:id/media', auth: 'management' },
  { method: 'PUT', path: 'staff/:id/media/order', auth: 'management' },
  { method: 'DELETE', path: 'staff/:id/media/:mediaId', auth: 'management' },
  { method: 'GET', path: 'public/masters', auth: 'public' },
  { method: 'GET', path: 'media/:key', auth: 'public' },
  { method: 'PUT', path: 'staff/:id/portfolio', auth: 'management' },
  { method: 'PUT', path: 'staff/:id/role', auth: 'management' },
  // Увольнение и возврат в команду (22.08.2026). Состав команды - management-решение,
  // тот же уровень, что и PUT /staff/:id
  { method: 'PUT', path: 'staff/:id/employment', auth: 'management' },
  { method: 'PUT', path: 'staff/:id/pin', auth: 'owner' },
  { method: 'GET', path: 'services', auth: 'any-staff' },
  { method: 'GET', path: 'master-services', auth: 'public' },
  { method: 'PUT', path: 'master-services/:masterId/:serviceId', auth: 'management' },
  { method: 'GET', path: 'bookings', auth: 'public' },
  { method: 'POST', path: 'bookings', auth: 'public' },
  { method: 'POST', path: 'bookings/:id/cancel', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/status', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/services', auth: 'any-staff' },
  { method: 'PUT', path: 'bookings/:id/services', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/reschedule', auth: 'any-staff' },
  { method: 'DELETE', path: 'bookings/:id', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/actual-price', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/client', auth: 'any-staff' },
  { method: 'GET', path: 'sales', auth: 'any-staff' },
  { method: 'POST', path: 'sales', auth: 'any-staff' },
  { method: 'GET', path: 'schedule', auth: 'public' },
  { method: 'POST', path: 'schedule', auth: 'any-staff' },
  { method: 'DELETE', path: 'schedule', auth: 'any-staff' },
  { method: 'GET', path: 'schedule-range', auth: 'any-staff' },
  { method: 'POST', path: 'schedule-exceptions', auth: 'any-staff' },
  { method: 'GET', path: 'holidays', auth: 'public' },
  { method: 'POST', path: 'holidays/close', auth: 'management' },
  { method: 'GET', path: 'schedule-availability', auth: 'public' },
  { method: 'GET', path: 'masters-next-availability', auth: 'public' },
  { method: 'GET', path: 'master-weekly-schedule', auth: 'any-staff' },
  { method: 'PUT', path: 'master-weekly-schedule', auth: 'any-staff' },
  { method: 'GET', path: 'notifications', auth: 'any-staff' },
  { method: 'GET', path: 'notifications/unread-count', auth: 'any-staff' },
  { method: 'POST', path: 'notifications/:id/read', auth: 'any-staff' },
  { method: 'POST', path: 'notifications/:id/dismiss', auth: 'any-staff' },
  { method: 'POST', path: 'notifications/read-all', auth: 'any-staff' },
  // 17.08.2026: деньги (ставки, зарплаты, выручка) - только владелец и управляющий
  { method: 'GET', path: 'payroll-settings', auth: 'management' },
  { method: 'PUT', path: 'payroll-settings', auth: 'management' },
  { method: 'GET', path: 'discount-settings', auth: 'any-staff' },
  { method: 'PUT', path: 'discount-settings', auth: 'management' },
  { method: 'GET', path: 'payroll', auth: 'management' },
  { method: 'GET', path: 'revenue/today', auth: 'management' },
  { method: 'GET', path: 'clients', auth: 'any-staff' },
  { method: 'GET', path: 'clients/:id', auth: 'any-staff' },
  // Срок обновления стрижки задним числом (Окно 59) - те же роли, что ставят статус
  // визита: разговор про срок ведёт тот же человек, что закрывает визит
  { method: 'PATCH', path: 'clients/:id/renew', auth: 'any-staff' },
  { method: 'GET', path: 'owner/alerts', auth: 'management' },
  // Аналитика салона - тот же круг, что и деньги: владелец и управляющий
  { method: 'GET', path: 'analytics/retention', auth: 'management' },
  { method: 'GET', path: 'analytics/sources', auth: 'management' },
  { method: 'GET', path: 'analytics/lapsed', auth: 'management' },
  { method: 'GET', path: 'analytics/unlinked', auth: 'management' },
  // Доля обсуждённых сроков по мастерам (Окно 59) - метрика того же круга, что вся
  // остальная аналитика
  { method: 'GET', path: 'analytics/renew-discussed', auth: 'management' },
  // Недополученная прибыль (Окно 59) - раздел «Финансы», деньги и телефоны клиентов
  { method: 'GET', path: 'finance/missed-profit', auth: 'management' },
  { method: 'GET', path: 'finance/missed-profit/clients', auth: 'management' },
  // Живое обновление кабинетов (17.08.2026). /events - поток событий от сервера,
  // /changes - его фолбэк опросом на случай, если прокси не пропустит долгое
  // соединение. Обоим достаточно любого валидного токена: они не отдают данных,
  // только сообщают, ЧТО изменилось - сами данные кабинет забирает своими роутами,
  // где права и проверяются
  // Резервная копия: реестр требует владельца, сам роут - ещё и отдельный секрет,
  // без которого отвечает 404. Выключен, пока не задан BACKUP_TOKEN
  { method: 'GET', path: 'backup', auth: 'owner' },
  { method: 'GET', path: 'events', auth: 'any-staff' },
  { method: 'GET', path: 'changes', auth: 'any-staff' },
];

// Экспортируется ради тестов (tests/api.pin-owner-only.test.js): решение «кто
// вообще допущен к роуту» принимает реестр, до обработчиков дело не доходит, и
// проверять это правильнее здесь, а не через живой HTTP.
export function matchRoute(method, parts) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const routeParts = route.path.split('/');
    if (routeParts.length !== parts.length) continue;
    if (routeParts.every((seg, i) => seg.startsWith(':') || seg === parts[i])) return route;
  }
  return null;
}

// Роуты, которым транзакция на запрос противопоказана (ловушка 3 спеки): поток живых
// событий держит ответ открытым часами и выел бы пул, /changes - счётчик в памяти без
// базы вообще, /media отдаёт файл с диска. Арендатор им известен, но соединение они не
// удерживают - каждый поход в базу внутри берёт своё короткое и сразу отпускает.
const DETACHED_ROUTES = new Set(['events', 'changes', 'media']);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // ── Проверка живости - до разбора домена ──────────────────────────────
    // Amvera опрашивает /health своими средствами, без источника запроса и без
    // отношения к арендаторам. Отвечать ему 404 «неизвестный домен» значило бы
    // объявить сервис мёртвым. Данных этот роут не отдаёт, только факт живой базы.
    if (url.pathname === '/health') {
      setCors(res, null);
      await registryQuery('SELECT 1 FROM tenants LIMIT 1');
      // Замок на уровне строк не действует на суперпользователя и на роль с
      // BYPASSRLS - на такой базе он выглядел бы поставленным, но не держал.
      // Проверить это снаружи нельзя: база Amvera живёт во внутренней сети.
      // Поэтому спрашиваем у самого приложения. Отдаём только «да/нет», без имён
      // ролей: это признак верной настройки, а не секрет.
      let dbRoleSafe = null;
      try {
        dbRoleSafe = await dbRoleIsSafe();
      } catch {
        // Проверка прав не должна ронять health - он про живость сервиса
      }
      return sendJson(res, 200, { ok: true, liveSubscribers: subscriberCount(), dbRoleSafe });
    }

    // ── Чей это запрос ────────────────────────────────────────────────────
    // Определяется по домену, ДО поиска роута и до любого обработчика. Неизвестный
    // домен получает 404, а не данные первого попавшегося арендатора (критерий 4).
    const tenant = await resolveTenantForRequest(req);
    setCors(res, corsOriginFor(tenant, req.headers.origin));
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!tenant) return sendJson(res, 404, { error: 'unknown_tenant' });

    // Долгие ответы (поток событий, медиа) пишут в соединение сами и транзакции на
    // запрос не имеют - им буфер не нужен и вреден. Остальным ответ копится и уходит
    // после COMMIT: до фиксации «готово» клиенту не обещаем (см. lib/http.js)
    if (DETACHED_ROUTES.has(parts[0])) {
      await runDetached(tenant.id, () => handleRequest(req, res, url, parts));
      return;
    }
    const buffer = createBufferedResponse(res);
    try {
      await runInTenant(tenant.id, () => handleRequest(req, buffer.res, url, parts));
    } catch (err) {
      // Транзакция уже откачена. Ответ обработчика (в том числе успешный) выбрасываем:
      // подтверждать запись, которой в базе не осталось, нельзя
      buffer.discard();
      throw err;
    }
    buffer.flush();
  } catch (err) {
    // Сюда приходит и упавший обработчик (транзакция запроса к этому моменту уже
    // откачена), и падение самого COMMIT. Ответ мог быть отправлен обработчиком -
    // тогда второй раз не отвечаем, только пишем в лог.
    console.error('Ошибка обработки запроса:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  }
});

async function handleRequest(req, res, url, parts) {
  try {
    // Гейт реестра - до любого обработчика ниже. Незарегистрированный
    // метод+путь получает 404 здесь и не доходит до if/else вообще.
    const matchedRoute = matchRoute(req.method, parts);
    if (!matchedRoute) return sendJson(res, 404, { error: 'route_not_found' });
    if (matchedRoute.auth !== 'public') {
      const gateAuth = await authenticate(req);
      if (matchedRoute.auth === 'management') {
        if (!canManageStaff(gateAuth)) return sendJson(res, 401, { error: 'unauthorized' });
      } else if (matchedRoute.auth === 'owner') {
        if (!requireRole(gateAuth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
      } else if (!gateAuth) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
    }

    // /health обработан выше, до разбора домена - сюда запрос уже не доходит

    // ── Живое обновление ────────────────────────────────────────────────
    // Ответ намеренно НЕ закрывается: соединение живёт, пока открыт кабинет.
    // Гейт реестра выше уже проверил токен, здесь только берём личность подписчика
    if (parts[0] === 'backup' && parts.length === 1 && req.method === 'GET') {
      return handleBackup(req, res);
    }

    if (parts[0] === 'events' && parts.length === 1 && req.method === 'GET') {
      // ИНЦИДЕНТ 24.08.2026, найден живым прогоном сразу после переключения на
      // мультиарендность. На Amvera (за прокси Envoy) живой поток событий блокирует
      // следующий запрос кабинета по тому же соединению: он висит без ответа, и
      // кабинет остаётся под шторкой загрузки. Локально, без прокси, того же кода
      // это не воспроизводится - проверено тем же браузером и тем же сценарием.
      //
      // Поток выключен по умолчанию, пока причина на стороне прокси не разобрана.
      // Кабинет от этого не ломается: у живых обновлений есть штатный фолбэк -
      // опрос GET /changes (assets/crm-live.js), он включается сам, когда поток
      // недоступен. Разница для человека: обновление раз в несколько секунд вместо
      // мгновенного.
      //
      // Включить обратно: переменная окружения LIVE_EVENTS=on в панели Amvera.
      if (process.env.LIVE_EVENTS !== 'on') return sendJson(res, 404, { error: 'events_disabled' });
      const auth = await authenticate(req);
      return addSubscriber(req, res, auth);
    }
    if (parts[0] === 'changes' && parts.length === 1 && req.method === 'GET') {
      return sendJson(res, 200, changesSnapshot());
    }

    // ── Auth ────────────────────────────────────────────────────────────
    if (parts[0] === 'auth' && parts[1] === 'login' && req.method === 'POST') {
      return handleLogin(req, res);
    }

    if (parts[0] === 'auth' && parts[1] === 'me' && req.method === 'GET') {
      return handleMe(req, res);
    }
    if (parts[0] === 'auth' && parts[1] === 'logout' && req.method === 'POST') return handleLogout(req, res);

    // ── /staff - роль ограничивает выдачу на уровне SQL, не только в UI ──
    if (parts[0] === 'staff' && parts.length === 1 && req.method === 'GET') {
      return handleStaffList(req, res);
    }
    if (parts[0] === 'locations' && parts.length === 1 && req.method === 'GET') return handleLocationsList(req, res);
    if (parts[0] === 'staff' && parts.length === 1 && req.method === 'POST') return handleStaffCreate(req, res);
    if (parts[0] === 'staff' && parts[1] && parts.length === 2 && req.method === 'PUT') return handleStaffUpdate(req, res, parts);
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'media' && parts.length === 3 && req.method === 'POST') return handleStaffMediaUpload(req,res,parts,url);
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'media' && parts[3] === 'order' && req.method === 'PUT') return handleStaffMediaOrder(req,res,parts);
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'media' && parts[3] && req.method === 'DELETE') return handleStaffMediaDelete(req,res,parts);
    if (parts[0] === 'public' && parts[1] === 'masters' && req.method === 'GET') return handlePublicMasters(req,res);
    if (parts[0] === 'media' && parts[1] && req.method === 'GET') { const key=parts[1]; if(!/^[a-f0-9]{36}\.webp$/.test(key)) return sendJson(res,404,{error:'media_not_found'}); try { const image=readFileSync(join(MEDIA_ROOT,key)); res.writeHead(200,{ 'Content-Type':'image/webp','Cache-Control':'public, max-age=86400' }); return res.end(image); } catch { return sendJson(res,404,{error:'media_not_found'}); } }

    // ── /staff/:id/portfolio - Задача 4 (Окно 13, 01.08.2026). Только владелец
    // редактирует (тот же уровень доступа, что у /payroll-settings PUT - Алихан сам
    // ведёт карточки сотрудников). Данных для заполнения сейчас нет (Алихан заполнит
    // сам) - этот эндпоинт даёт саму возможность, не контент.
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'portfolio' && parts.length === 3 && req.method === 'PUT') {
      return handleStaffPortfolio(req, res, parts);
    }

    // ── /staff/:id/role - Задача 1 (Окно 14, 02.08.2026). Владелец меняет роль
    // сотрудника (например Мамедхан master→admin) - раньше чекбоксы роли в
    // crm-owner.html были кликабельны, но физически ничего не сохраняли, эндпоинта
    // не существовало вообще. Owner-only - роль решает исключительно Алихан.
    // ── /staff/:id/pin - владелец задаёт PIN сотруднику (20.08.2026). Роль
    //    проверяет реестр (auth: 'owner'), сюда чужая уже не доходит.
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'pin' && parts.length === 3 && req.method === 'PUT') {
      return handleStaffPinSet(req, res, parts);
    }
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'role' && parts.length === 3 && req.method === 'PUT') {
      return handleStaffRole(req, res, parts);
    }

    // ── /staff/:id/employment - уволить / вернуть в команду (22.08.2026).
    // Не удаление: строка сотрудника живёт дальше, чтобы его брони, зарплаты и
    // аналитика за отработанные периоды остались на месте (миграция 055).
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'employment' && parts.length === 3 && req.method === 'PUT') {
      return handleStaffEmployment(req, res, parts);
    }

    // ── /services - каталог, доступен любой авторизованной роли ──────────
    if (parts[0] === 'services' && parts.length === 1 && req.method === 'GET') {
      return handleServicesList(req, res);
    }

    // ── /master-services - цена и длительность ПО МАСТЕРУ (Окно 10, разд.17.2 ТЗ) ──
    // Один и тот же каталог услуг, разные мастера могут стоить по-разному (Елизавета
    // дешевле Али/Мамедхана) - см. миграцию 004_master_prices.sql. Правка 03.08.2026:
    // раньше требовал логин, "публичный сайт эти данные не запрашивает" (работал на
    // статике storage.js) - это и была причина бага (клиент видел все 8 услуг у
    // любого мастера, включая те, что мастер не оказывает). Теперь анонимный доступ
    // разрешён так же, как уже сделано для /schedule (Окно 15) - ничего чувствительнее
    // цены/длительности здесь нет, эти цифры и так были видны на сайте захардкоженными.
    if (parts[0] === 'master-services' && parts.length === 1 && req.method === 'GET') {
      return handleMasterServicesList(req, res);
    }

    // ── /master-services/:masterId/:serviceId - Правка 03.08.2026, только владелец.
    // Раньше в карточке сотрудника были чекбоксы "какие услуги умеет" и поле
    // длительности - оба были чистой декорацией (никакого fetch, см. отчёт сессии),
    // хотя master_services в базе уже поддерживала ровно это с самого Окна 8. Теперь
    // реально включает/выключает услугу у мастера и его личную длительность.
    // enabled:false удаляет строку (мастер больше не оказывает услугу) - не бронь
    // затрагивает, только каталог на будущее. enabled:true создаёт/обновляет строку,
    // duration_min по умолчанию берётся из общего каталога services, если не передан.
    if (
      parts[0] === 'master-services' &&
      parts[1] &&
      parts[2] &&
      parts.length === 3 &&
      req.method === 'PUT'
    ) {
      return handleMasterServiceUpdate(req, res, parts);
    }

    // ── /bookings - GET публичный (без клиентских данных) + по роли, POST для записи ──
    if (parts[0] === 'bookings' && parts.length === 1) {
      return handleBookings(req, res, url);
    }

    // ── /bookings/:id - НАСТОЯЩЕЕ удаление (08.08.2026) - см. подробный комментарий
    // у handleBookingDelete, api/routes/bookings.js. parts.length===2 отличает этот
    // роут от /bookings/:id/cancel|status|services ниже (length===3).
    if (parts[0] === 'bookings' && parts[1] && parts.length === 2 && req.method === 'DELETE') {
      return handleBookingDelete(req, res, parts);
    }

    // ── /bookings/:id/cancel - Задача 2 (Окно 13, 01.08.2026, Блок 5 в.19). Отмена
    // сама по себе ничем не ограничена по времени - ограничено только право на полный
    // возврат. Онлайн-оплаты в MVP нет (см. Ограничения промпта), поэтому "возврат"
    // здесь не реальная транзакция, а флаг refundEligible в ответе, на который
    // ориентируется сотрудник в разговоре с клиентом. Доступ сужен той же матрицей,
    // что и видимость самой брони (listBookingsForRequest): owner - любая, admin -
    // только своя точка, master - только свои записи.
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'cancel' && parts.length === 3 && req.method === 'POST') {
      return handleBookingCancel(req, res, parts);
    }

    // ── /bookings/:id/status - Задачи 3 и 6 (Окно 13, 01.08.2026). Простановка факта
    // визита (владелец/администратор/мастер). 'cancelled' сюда намеренно не входит -
    // для отмены есть отдельный /bookings/:id/cancel с проверкой порога 2 часа
    // (Задача 2), общий сеттер статуса не должен давать возможность обойти эту
    // проверку.
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'status' && parts.length === 3 && req.method === 'PATCH') {
      return handleBookingStatus(req, res, parts);
    }

    // ── /bookings/:id/services - добавление услуги к уже существующей записи
    // (08.08.2026) - см. подробный комментарий у handleBookingAddServices,
    // api/routes/bookings.js.
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'services' && parts.length === 3 && req.method === 'PATCH') {
      return handleBookingAddServices(req, res, parts);
    }

    // ── PUT /bookings/:id/services - ПОЛНЫЙ состав услуг записи (13.08.2026):
    // в отличие от PATCH выше умеет и СНЯТЬ услугу (клиент передумал уже в кресле),
    // пересчитывая конец слота от начала записи - см. handleBookingSetServices,
    // api/routes/bookings.js. owner/admin, мастер остаётся на PATCH.
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'services' && parts.length === 3 && req.method === 'PUT') {
      return handleBookingSetServices(req, res, parts);
    }

    // ── /bookings/:id/reschedule - перенос записи на другого мастера/дату/время
    // (Окно 54, 10.08.2026, Задача B) - см. подробный комментарий у
    // handleBookingReschedule, api/routes/bookings.js.
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'reschedule' && parts.length === 3 && req.method === 'PATCH') {
      return handleBookingReschedule(req, res, parts);
    }

    // ── /bookings/:id/actual-price - фактически взятая сумма (08.08.2026, вечер) -
    // см. подробный комментарий у handleBookingActualPrice, api/routes/bookings.js.
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'actual-price' && parts.length === 3 && req.method === 'PATCH') {
      return handleBookingActualPrice(req, res, parts);
    }

    // ── /bookings/:id/client - имя и телефон клиента у существующей записи
    // (16.08.2026, Влад: правки этих двух полей никуда не сохранялись - роута не было).
    if (parts[0] === 'bookings' && parts[1] && parts[2] === 'client' && parts.length === 3 && req.method === 'PATCH') {
      return handleBookingClient(req, res, parts);
    }

    // ── /sales - продажа (косметика и т.п.), привязана к визиту (разд.14.3 п.2) ──
    if (parts[0] === 'sales' && parts.length === 1) {
      return handleSales(req, res, url);
    }

    // ── /schedule - смены + перерывы (список интервалов, разд.14.1) ──────
    if (parts[0] === 'schedule' && parts.length === 1) {
      return handleSchedule(req, res, url);
    }

    // ── /schedule-range - Задача 1 промпта Окна 17 (04.08.2026). Эффективный график
    // на каждый день диапазона одним запросом - без него Неделя/Месяц в CRM слали бы
    // до 31 отдельного GET /schedule?date=... (тот же принцип экономии запросов, что
    // уже применён у GET /bookings?from=&to=, см. listBookingsForRequest выше).
    if (parts[0] === 'schedule-range' && parts.length === 1 && req.method === 'GET') {
      return handleScheduleRange(req, res, url);
    }
    if (parts[0] === 'schedule-exceptions' && parts.length === 1 && req.method === 'POST') return handleScheduleExceptions(req, res);

    // ── /holidays - производственный календарь (Окно 24, 05.08.2026). Анонимный
    // GET: тот же уровень доступа, что у /services и узкого /schedule - публичному
    // виджету записи (index.html, без логина) он нужен, чтобы подсказать клиенту
    // "выбранная дата - праздник", а приватного в списке красных дней страны ничего нет.
    if (parts[0] === 'holidays' && parts.length === 1 && req.method === 'GET') {
      return handleHolidaysList(req, res, url);
    }

    // POST /holidays/close - "закрыть эти даты всем мастерам" одним действием, вместо
    // ручного прохода по каждому мастеру и каждому дню в модалке дня. Owner-only: это
    // решение по всему салону сразу, у админа точки таких прав нет нигде (ср. PUT
    // /payroll-settings). Закрытие дня выполняет ТА ЖЕ applyScheduleDay, что применяет
    // одобренный отгул (PATCH /schedule-requests/:id/decision) - отдельной механики
    // "выходной по празднику" в базе не заводим, иначе в графике появилось бы два
    // разных выходных с разным поведением.
    if (parts[0] === 'holidays' && parts[1] === 'close' && parts.length === 2 && req.method === 'POST') {
      return handleHolidaysClose(req, res);
    }

    // ── /schedule-availability - Задача 1 промпта Окна 21 (04.08.2026). Реальная
    // доступность мастер+услуга по каждой дате диапазона - календарь клиента (Задача 2
    // этого же окна) красит недоступные даты серым ДО клика, вместо того чтобы узнавать
    // про занятость только после выбора даты (GET /schedule) или вовсе на POST /bookings
    // (schedule_blocked). Анонимный доступ - тот же уровень, что у GET /schedule (публичный
    // виджет записи, без логина), только с явными masterId+serviceId+узкий диапазон дат.
    if (parts[0] === 'schedule-availability' && parts.length === 1 && req.method === 'GET') {
      return handleScheduleAvailability(req, res, url);
    }

    // ── /masters-next-availability - Задача 1 промпта Окна 26 (04.08.2026). Батч-ответ
    // для ВСЕХ бронируемых мастеров разом (не по одному запросу на мастера) - карточка
    // мастера на публичном виджете (Задача 2 этого же окна) показывает бейдж доступности
    // ДО того, как клиент вообще выбрал мастера или услугу, поэтому все три карточки
    // обновляются одним анонимным запросом при загрузке страницы. Анонимный доступ - тот
    // же уровень, что у GET /master-services (ничего чувствительнее даты здесь нет).
    // "Бронируемый мастер" = мастер, у которого есть хотя бы одна строка в
    // master_services (иначе бронировать у него нечего, отдаём nextAvailableDate: null,
    // не 500 и не выдуманную дату).
    if (parts[0] === 'masters-next-availability' && parts.length === 1 && req.method === 'GET') {
      return handleMastersNextAvailability(req, res);
    }

    // ── /master-weekly-schedule - единый блок "График работы" (Окно 16, 03.08.2026,
    // заменяет прежний /schedule-recurring - разд.28/41 промпта). Одна строка на
    // каждый день недели (master_weekly_schedule): работает/выходной, рабочее окно,
    // опциональный перерыв - весь день описывается сразу, не два разрозненных места.
    // Владелец/админ своей точки правят НАПРЯМУЮ (тот же уровень доступа, что у POST
    // /schedule для разовых дат) - согласование мастера см. /schedule-requests ниже
    // (category=grafik_standard).
    if (parts[0] === 'master-weekly-schedule' && parts.length === 1) {
      return handleMasterWeeklySchedule(req, res, url);
    }

    // Роуты /schedule-requests сняты 20.08.2026 (решение Влада): мастер больше не
    // подаёт заявки на отгул/отпуск - форма удалена из crm-master.html, блок заявок из
    // crm-owner.html, уведомления о них из ленты (миграция 051). Отгул мастеру ставит
    // владелец напрямую (POST /schedule на дату). Таблица schedule_change_requests
    // осталась в базе с историей решений, но обработчиков к ней больше нет: держать
    // открытый POST, который создаёт заявку, которую никто уже не увидит, - хуже, чем
    // честный 404.

    // ── /notifications - Задача 5 (Окно 14, 02.08.2026). In-app поллинг, не push -
    // список/бейдж на странице, обновляется по таймеру фронтенда.
    if (parts[0] === 'notifications' && parts.length === 1 && req.method === 'GET') {
      return handleNotificationsList(req, res, url);
    }

    if (parts[0] === 'notifications' && parts[1] === 'unread-count' && parts.length === 2 && req.method === 'GET') {
      return handleNotificationsUnreadCount(req, res);
    }

    if (parts[0] === 'notifications' && parts[1] && parts[2] === 'read' && parts.length === 3 && req.method === 'POST') {
      return handleNotificationRead(req, res, parts);
    }

    // Убрать из колокольчика - в разделе «Уведомления» строка остаётся
    if (parts[0] === 'notifications' && parts[1] && parts[2] === 'dismiss' && parts.length === 3 && req.method === 'POST') {
      return handleNotificationDismiss(req, res, parts);
    }

    if (parts[0] === 'notifications' && parts[1] === 'read-all' && parts.length === 2 && req.method === 'POST') {
      return handleNotificationsReadAll(req, res);
    }

    // ── /payroll-settings - ставка ПО МАСТЕРУ (Окно 10, разд.17.3 ТЗ). Заменяет
    // единую строку payroll_settings (% по категории услуги + бонус за нового
    // клиента - оба подтверждённо не соответствуют реальной формуле Алихана,
    // разд.17.3/17.4) на master_payroll_settings: у каждого мастера одна
    // редактируемая ставка pct. Читать может любая роль (мастеру нужна своя ставка
    // для "Моей зарплаты"), но выдача сужена по той же матрице, что и /staff -
    // мастер видит только себя, админ только свою точку, владелец - всех. Менять
    // ставку может только владелец (разд.7 ТЗ: "Изменение прайса - я").
    if (parts[0] === 'payroll-settings' && parts.length === 1) {
      return handlePayrollSettings(req, res, url);
    }

    // ── /discount-settings - "Управление скидками" (08.08.2026, вечер) - см.
    // подробный комментарий у handleDiscountSettings, api/routes/payroll.js.
    if (parts[0] === 'discount-settings' && parts.length === 1) {
      return handleDiscountSettings(req, res);
    }

    // ── /payroll - Окно 37 (06.08.2026, Задача 1). ЗП мастера за произвольный
    // период (masterId+from+to) через computeMasterPayroll - единый резолвер вместо
    // клиентского дубля формулы. Мастер не может запросить чужую ЗП, даже подставив
    // чужой masterId в query - роль форсирует свой id, тот же приём, что уже есть у
    // /payroll-settings и listBookingsForRequest. Админ ограничен своей точкой
    // (проверка location_id) - тот же уровень защиты денежных данных, что и у
    // /payroll-settings GET, роут не завязан только на текущего потребителя
    // (crm-master.html), должен быть безопасен и при будущем переиспользовании.
    if (parts[0] === 'payroll' && parts.length === 1 && req.method === 'GET') {
      return handlePayroll(req, res, url);
    }

    // ── /revenue/today - Окно 38 (06.08.2026). Дневная выручка через
    // computeRevenueToday. Тот же приём разграничения по роли, что у /staff и
    // /payroll: администратор форсирован на свою точку (не может передать чужой
    // locationId), владелец без locationId получает сумму по ВСЕМ точкам, с
    // locationId - по конкретной.
    if (parts[0] === 'revenue' && parts[1] === 'today' && parts.length === 2 && req.method === 'GET') {
      return handleRevenueToday(req, res, url);
    }

    // ── /owner/alerts - Окно 40 (06.08.2026). Один агрегирующий роут для дашборда
    // "Сегодня" через computeOwnerAlerts - владелец получает три источника алертов
    // (мастера без графика, необработанные заявки, клиенты в риске) одним запросом.
    if (parts[0] === 'owner' && parts[1] === 'alerts' && parts.length === 2 && req.method === 'GET') {
      return handleOwnerAlerts(req, res);
    }

    // ── /analytics/* (22.08.2026, задача Влада) - раздел «Аналитика» владельца.
    // retention - возвращаемость по салону И по каждому мастеру за 3/6/12/24/36
    // месяцев, sources - распределение записей по каналам привлечения (Яндекс Карты,
    // 2ГИС, Инстаграм, …) за 1/3/6/12 месяцев. Оба считаются из уже существующих
    // полей броней (status/client_id и client_source, миграция 050) - новых таблиц
    // задача не потребовала. Словарь допустимых каналов аналитика берёт оттуда же,
    // откуда его берёт запись брони (CLIENT_SOURCE_KEYS, api/routes/bookings.js) -
    // второго списка каналов в системе нет.
    if (parts[0] === 'analytics' && parts[1] === 'retention' && parts.length === 2 && req.method === 'GET') {
      return handleAnalyticsRetention(req, res, url);
    }
    if (parts[0] === 'analytics' && parts[1] === 'sources' && parts.length === 2 && req.method === 'GET') {
      return handleAnalyticsSources(req, res, url);
    }
    // lapsed - поимённо те, кто за период пришёл ровно один раз (правка Влада
    // 22.08.2026: из цифры возвращаемости нужен переход к самим клиентам). unlinked -
    // сколько всего визитов без телефона: в списке клиентов их нет намеренно, но
    // считать их система обязана.
    if (parts[0] === 'analytics' && parts[1] === 'lapsed' && parts.length === 2 && req.method === 'GET') {
      return handleAnalyticsLapsed(req, res, url);
    }
    if (parts[0] === 'analytics' && parts[1] === 'unlinked' && parts.length === 2 && req.method === 'GET') {
      return handleAnalyticsUnlinked(req, res);
    }
    if (parts[0] === 'analytics' && parts[1] === 'renew-discussed' && parts.length === 2 && req.method === 'GET') {
      return handleAnalyticsRenewDiscussed(req, res, url);
    }

    // ── /finance/missed-profit - «Недополученная прибыль» (Окно 59, 22.08.2026).
    // Карточка отдаёт только суммы, список людей с телефонами - отдельной ручкой,
    // когда владелец действительно раскрыл список.
    if (parts[0] === 'finance' && parts[1] === 'missed-profit' && parts.length === 2 && req.method === 'GET') {
      return handleMissedProfit(req, res, url);
    }
    if (parts[0] === 'finance' && parts[1] === 'missed-profit' && parts[2] === 'clients' && parts.length === 3 && req.method === 'GET') {
      return handleMissedProfitClients(req, res, url);
    }

    // ── /clients?risk=true - Окно 39 (06.08.2026, Задача 1). Список "требует
    // внимания" через listClientsAtRisk. Тот же приём разграничения по роли, что у
    // /payroll и /revenue/today: admin форсирован на свою точку, master - на своих
    // клиентов (тех, у кого есть бронь с этим мастером), owner видит всех. Телефон -
    // тот же уровень видимости, что в GET /bookings (разд.12 п.1 ТЗ): мастеру не отдаём.
    if (parts[0] === 'clients' && parts.length === 1 && req.method === 'GET') {
      return handleClientsAtRisk(req, res, url);
    }

    // ── /clients/:id - Окно 39 (06.08.2026, Задача 1). Карточка клиента через
    // getClientCard. Резолвер роль-агностичен (всегда отдаёт полную карточку) -
    // scoping и видимость телефона решает роут: admin видит клиента только если у
    // него есть хоть один визит на точке admin'а, master - только если есть визит У
    // ЭТОГО мастера (403, не тихий пустой ответ - тот же приём, что у /payroll с
    // чужим masterId). Существование клиента проверяется ДО scope-проверки - 404
    // для несуществующего id одинаков для всех ролей, не палит своей/чужой доступ.
    if (parts[0] === 'clients' && parts.length === 2 && req.method === 'GET') {
      return handleClientCard(req, res, parts);
    }
    if (parts[0] === 'clients' && parts[1] && parts[2] === 'renew' && parts.length === 3 && req.method === 'PATCH') {
      return handleClientRenew(req, res, parts);
    }

    sendJson(res, 404, { error: 'route_not_found' });
  } catch (err) {
    // Ответ клиенту тот же, что и раньше, но ошибка идёт дальше наверх: транзакция
    // запроса обязана откатиться, а не закоммитить то, что обработчик успел записать
    // до падения.
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    throw err;
  }
}

// Простой авто-раннер миграций (правка 28.07.2026) - раньше новые .sql-файлы в
// migrations/ применялись вручную (нет доступа к psql/консоли Amvera из Claude Code
// между сессиями, ключ для SSH-деплоя одноразовый). Теперь при каждом старте сервер
// сам догоняет непроменённые файлы по имени, по одному разу каждый - без внешнего
// инструмента, без хардкода списка версий.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function runMigrations() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())'
  );
  const applied = new Set((await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename));

  // Задача D промпта Окна 29 (05.08.2026): до этой правки здесь был особый случай -
  // на пустой schema_migrations 001/002 помечались "применёнными" БЕЗ выполнения
  // (на боевой базе Amvera их накатили вручную ДО появления этого раннера, а их
  // INSERT-сиды упали бы на уже существующих строках). На боевой базе это больше не
  // нужно - schema_migrations там уже содержит явные строки '001_kv_store.sql' и
  // '002_schema.sql' (тот особый случай вставил их при самом первом старте раннера),
  // поэтому обычный `if (applied.has(file)) continue` ниже пропустит их сам, без
  // особого случая. На СВЕЖЕЙ базе (schema_migrations пустая) 001/002 теперь просто
  // выполняются как все остальные файлы по порядку - оба файла сделаны идемпотентными
  // (CREATE TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING), поэтому это безопасно.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Миграция применена: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`Миграция ${file} упала, сервер не стартует:`, err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

// Фоновый сканер напоминаний («за 15 минут», «время пришло») снят 20.08.2026 по
// решению Влада: «нужны уведомления только в момент записи, за 15 минут не нужно».
// Уведомление о записи создаётся один раз, в момент её создания (notifyStaff в
// createBookingTx). Типы 'booking_reminder_15'/'booking_start' убраны из CHECK
// миграцией 051 - вернуть сканер без обратной миграции уже нельзя, INSERT упадёт.

// Окно 17 (04.08.2026) - миграции/фоновый сканер/listen раньше запускались на верхнем
// уровне модуля безусловно, поэтому импорт server.mjs (например из node --test для
// юнитов на чистых функциях резолвера) тянул за собой реальное подключение к БД и
// висящий процесс. Guard по стандартному ESM-паттерну "это главный модуль?" - при
// прямом запуске (`node server.mjs`, см. api/package.json start) ничего не меняется,
// при импорте как модуля - побочные эффекты не срабатывают.
async function startServer() {
  // Служебный контекст: схема меняется поверх всех арендаторов сразу, политика
  // доступа (Фаза 3) пропускает только это значение и только отсюда.
  await runInTenant(SYSTEM_TENANT, runMigrations);
  server.listen(PORT, () => {
    console.log(`API alikhan-crm слушает порт ${PORT}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
