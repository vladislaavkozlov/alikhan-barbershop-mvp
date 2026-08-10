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
import { setCors, sendJson } from './lib/http.js';
import { pool } from './lib/db.js';
import { authenticate, requireRole } from './lib/auth.js';
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
import { notifyStaff } from './lib/notify-core.js';
export { findMastersMissingSchedule, notifyOwnerAboutMastersMissingSchedule } from './lib/notify-core.js';
// Ре-экспорт для tests/*.test.js, которые импортируют эти имена напрямую из
// server.mjs (in-memory юниты без реального Postgres) - см. правило 6 плана
// декомпозиции, plans/2026-08-07-server-mjs-decomposition.md.
export { isoWeekday, enumerateDateRange } from './lib/time.js';
import { handleLogin, handleMe } from './routes/auth.js';
import { handleStaffList, handleStaffPortfolio, handleStaffRole } from './routes/staff.js';
import { handleServicesList, handleMasterServicesList, handleMasterServiceUpdate } from './routes/services.js';
import { handleBookings, handleBookingCancel, handleBookingStatus, handleBookingAddServices, handleBookingReschedule, handleBookingActualPrice, handleBookingDelete, handleSales } from './routes/bookings.js';
// Ре-экспорт для tests/api.booking-reschedule.test.js (Окно 54, Задача B и C).
export { checkSlotAvailability, resolveRescheduleDuration, planRescheduleNotifications, formatMoveSlot } from './routes/bookings.js';
import {
  handleSchedule,
  handleScheduleRange,
  handleHolidaysList,
  handleHolidaysClose,
  handleScheduleAvailability,
  handleMastersNextAvailability,
  handleMasterWeeklySchedule,
} from './routes/schedule.js';
import {
  handleScheduleRequests,
  handleScheduleRequestDecision,
  handleScheduleRequestCancel,
} from './routes/schedule-requests.js';
import {
  handleNotificationsList,
  handleNotificationsUnreadCount,
  handleNotificationRead,
  handleNotificationsReadAll,
} from './routes/notifications.js';
import { handlePayrollSettings, handlePayroll, handleRevenueToday, handleDiscountSettings } from './routes/payroll.js';
import { handleOwnerAlerts, handleClientsAtRisk, handleClientCard } from './routes/clients.js';
// Ре-экспорт для tests/*.test.js.
export { describeClientRisk, getClientCard, listClientsAtRisk, computeOwnerAlerts } from './routes/clients.js';
export { normalizePhoneKey, findClientByPhone, resolveClientsQueryMode, shapeClientCardForViewer } from './routes/clients.js';
export { computeMasterPayroll, computeRevenueToday } from './routes/payroll.js';

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
  { method: 'GET', path: 'staff', auth: 'any-staff' },
  { method: 'PUT', path: 'staff/:id/portfolio', auth: 'owner' },
  { method: 'PUT', path: 'staff/:id/role', auth: 'owner' },
  { method: 'GET', path: 'services', auth: 'any-staff' },
  { method: 'GET', path: 'master-services', auth: 'public' },
  { method: 'PUT', path: 'master-services/:masterId/:serviceId', auth: 'owner' },
  { method: 'GET', path: 'bookings', auth: 'public' },
  { method: 'POST', path: 'bookings', auth: 'public' },
  { method: 'POST', path: 'bookings/:id/cancel', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/status', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/services', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/reschedule', auth: 'any-staff' },
  { method: 'DELETE', path: 'bookings/:id', auth: 'any-staff' },
  { method: 'PATCH', path: 'bookings/:id/actual-price', auth: 'any-staff' },
  { method: 'GET', path: 'sales', auth: 'any-staff' },
  { method: 'POST', path: 'sales', auth: 'any-staff' },
  { method: 'GET', path: 'schedule', auth: 'public' },
  { method: 'POST', path: 'schedule', auth: 'any-staff' },
  { method: 'DELETE', path: 'schedule', auth: 'any-staff' },
  { method: 'GET', path: 'schedule-range', auth: 'any-staff' },
  { method: 'GET', path: 'holidays', auth: 'public' },
  { method: 'POST', path: 'holidays/close', auth: 'owner' },
  { method: 'GET', path: 'schedule-availability', auth: 'public' },
  { method: 'GET', path: 'masters-next-availability', auth: 'public' },
  { method: 'GET', path: 'master-weekly-schedule', auth: 'any-staff' },
  { method: 'PUT', path: 'master-weekly-schedule', auth: 'any-staff' },
  { method: 'POST', path: 'schedule-requests', auth: 'any-staff' },
  { method: 'GET', path: 'schedule-requests', auth: 'any-staff' },
  { method: 'PATCH', path: 'schedule-requests/:id/decision', auth: 'owner' },
  { method: 'PATCH', path: 'schedule-requests/:id/cancel', auth: 'owner' },
  { method: 'GET', path: 'notifications', auth: 'any-staff' },
  { method: 'GET', path: 'notifications/unread-count', auth: 'any-staff' },
  { method: 'POST', path: 'notifications/:id/read', auth: 'any-staff' },
  { method: 'POST', path: 'notifications/read-all', auth: 'any-staff' },
  { method: 'GET', path: 'payroll-settings', auth: 'any-staff' },
  { method: 'PUT', path: 'payroll-settings', auth: 'owner' },
  { method: 'GET', path: 'discount-settings', auth: 'any-staff' },
  { method: 'PUT', path: 'discount-settings', auth: 'owner' },
  { method: 'GET', path: 'payroll', auth: 'any-staff' },
  { method: 'GET', path: 'revenue/today', auth: 'any-staff' },
  { method: 'GET', path: 'clients', auth: 'any-staff' },
  { method: 'GET', path: 'clients/:id', auth: 'any-staff' },
  { method: 'GET', path: 'owner/alerts', auth: 'owner' },
];

function matchRoute(method, parts) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const routeParts = route.path.split('/');
    if (routeParts.length !== parts.length) continue;
    if (routeParts.every((seg, i) => seg.startsWith(':') || seg === parts[i])) return route;
  }
  return null;
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // Гейт реестра - до любого обработчика ниже. Незарегистрированный
    // метод+путь получает 404 здесь и не доходит до if/else вообще.
    const matchedRoute = matchRoute(req.method, parts);
    if (!matchedRoute) return sendJson(res, 404, { error: 'route_not_found' });
    if (matchedRoute.auth !== 'public') {
      const gateAuth = await authenticate(req);
      if (matchedRoute.auth === 'owner') {
        if (!requireRole(gateAuth, ['owner'])) return sendJson(res, 401, { error: 'unauthorized' });
      } else if (!gateAuth) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
    }

    if (url.pathname === '/health') {
      await pool.query('SELECT 1');
      return sendJson(res, 200, { ok: true });
    }

    // ── Auth ────────────────────────────────────────────────────────────
    if (parts[0] === 'auth' && parts[1] === 'login' && req.method === 'POST') {
      return handleLogin(req, res);
    }

    if (parts[0] === 'auth' && parts[1] === 'me' && req.method === 'GET') {
      return handleMe(req, res);
    }

    // ── /staff - роль ограничивает выдачу на уровне SQL, не только в UI ──
    if (parts[0] === 'staff' && parts.length === 1 && req.method === 'GET') {
      return handleStaffList(req, res);
    }

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
    if (parts[0] === 'staff' && parts[1] && parts[2] === 'role' && parts.length === 3 && req.method === 'PUT') {
      return handleStaffRole(req, res, parts);
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

    // ── /schedule-requests - согласование графика (Задача 3, Окно 14, 02.08.2026).
    // Мастер запрашивает перерыв/выходной → владелец получает уведомление →
    // одобряет/отклоняет → только при одобрении время реально блокируется
    // (applyScheduleDay + проверка в createBookingTx выше).
    if (parts[0] === 'schedule-requests' && parts.length === 1) {
      return handleScheduleRequests(req, res, url);
    }

    // ── /schedule-requests/:id/decision - owner-only (Задача 3, Окно 14). Admin -
    // только просмотр списка выше, решает исключительно владелец (см. Ограничения
    // промпта - Мамедхан approve/reject не получает).
    if (parts[0] === 'schedule-requests' && parts[1] && parts[2] === 'decision' && parts.length === 3 && req.method === 'PATCH') {
      return handleScheduleRequestDecision(req, res, parts);
    }

    // ── /schedule-requests/:id/cancel - owner-only (Окно 23, 04.08.2026). Отменяет
    // УЖЕ ОДОБРЕННУЮ заявку на отгул/отпуск целиком: снимает блокировку со ВСЕХ дат
    // диапазона одним действием и переводит саму заявку в 'cancelled'. До этого окна
    // владелец мог только точечно сбросить одну дату (DELETE /schedule?masterId=&date=,
    // кнопка "Сбросить к стандартному") - на трёхдневном отпуске это три отдельных
    // действия, а статус заявки всё равно оставался "approved" и врал в истории.
    //
    // Откат каждой даты - ровно та же операция, что у DELETE /schedule: удаляем строку
    // schedule_shifts, schedule_breaks уходят каскадом (002_schema.sql:90), и
    // getEffectiveSchedule сам возвращается на недельный график/глобальный дефолт.
    // Следствие, осознанное (то же, что у кнопки "Сбросить к стандартному"): если на
    // дату из диапазона у мастера была ЕЩЁ и разовая правка владельца (свои часы на
    // этот день), она удалится вместе с отгулом - отдельного слоя "чей это shift" в
    // схеме нет, и заводить его в рамках этого окна никто не просил.
    if (parts[0] === 'schedule-requests' && parts[1] && parts[2] === 'cancel' && parts.length === 3 && req.method === 'PATCH') {
      return handleScheduleRequestCancel(req, res, parts);
    }

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

    sendJson(res, 404, { error: 'route_not_found' });
  } catch (err) {
    console.error('Ошибка обработки запроса:', err);
    sendJson(res, 500, { error: 'internal_error' });
  }
});

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

// Задача 5 (Окно 14, 02.08.2026) - фоновый сканер "за 15 минут"/"время пришло" по
// сегодняшним броням. Раз в минуту, не системный push - только заполняет таблицу
// notifications, которую опрашивает уже открытая страница (см. GET /notifications
// выше). Уникальные индексы миграции 015 защищают от дублей при каждом тике.
// Узкие окна ниже [now, now+16мин) и (now-2мин, now] - grace-защита от лавины
// уведомлений, если сервер был выключен и стартует спустя часы: старые брони, чьё
// время реминдера/начала давно прошло, просто не попадают в окно, не бэкфилятся пачкой.
async function scanBookingReminders() {
  try {
    const now = Date.now();
    const todayStr = new Date(now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10); // МСК = UTC+3 круглый год
    const result = await pool.query(
      `SELECT id, master_id, start_time FROM bookings WHERE date = $1 AND status != 'cancelled'`,
      [todayStr]
    );
    for (const row of result.rows) {
      const startMs = new Date(`${todayStr}T${row.start_time}:00+03:00`).getTime();
      const minutesUntil = (startMs - now) / (1000 * 60);
      if (minutesUntil >= 0 && minutesUntil <= 16) {
        await notifyStaff(pool, row.master_id, 'booking_reminder_15', {
          bookingId: row.id,
          title: 'Через 15 минут запись',
          body: row.start_time,
        });
      }
      if (minutesUntil <= 0 && minutesUntil >= -2) {
        await notifyStaff(pool, row.master_id, 'booking_start', {
          bookingId: row.id,
          title: 'Время записи наступило',
          body: row.start_time,
        });
      }
    }
  } catch (err) {
    console.error('scanBookingReminders упал (не критично, попробуем через минуту):', err.message);
  }
}
// Окно 17 (04.08.2026) - миграции/фоновый сканер/listen раньше запускались на верхнем
// уровне модуля безусловно, поэтому импорт server.mjs (например из node --test для
// юнитов на чистых функциях резолвера) тянул за собой реальное подключение к БД и
// висящий процесс. Guard по стандартному ESM-паттерну "это главный модуль?" - при
// прямом запуске (`node server.mjs`, см. api/package.json start) ничего не меняется,
// при импорте как модуля - побочные эффекты не срабатывают.
async function startServer() {
  await runMigrations();
  setInterval(scanBookingReminders, 60 * 1000);
  server.listen(PORT, () => {
    console.log(`API alikhan-crm слушает порт ${PORT}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
