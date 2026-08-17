// Бизнес-логика графика/расписания (без HTTP) - вынесено из server.mjs при
// декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код перенесён без
// изменений. Используется несколькими доменами роутов одновременно (bookings,
// staff, notifications, schedule, schedule-requests) - см. карту зависимостей в
// plans/2026-08-07-server-mjs-decomposition.md.
import { toMinutes, isoWeekday, intervalsOverlap, dateColToStr, shopNow } from './time.js';

// Правка 03.08.2026: недельный график (master_weekly_schedule) действует бессрочно
// (нет конечной даты), поэтому проверка конфликтов с уже существующими бронями при
// сохранении/одобрении делается на конечном окне вперёд, а не "навсегда" - после
// сохранения НОВЫЕ конфликтующие брони уже не создать (createBookingTx сверяется с
// getEffectiveSchedule), риск есть только для броней, сделанных ДО правки графика.
const RECURRING_CONFLICT_LOOKAHEAD_DAYS = 90;

// Глобальный дефолт рабочего окна, когда для мастера нет ни явной правки на дату
// (schedule_shifts), ни строки в master_weekly_schedule на этот день недели - тот
// же фолбэк 10:00-20:00, что и раньше (см. storage.js MASTERS[].workWindow).
const GLOBAL_DEFAULT_START = '10:00';
const GLOBAL_DEFAULT_END = '20:00';

// Правка Влада 03.08.2026 (Окно 16): единый блок "График работы" - рабочее окно
// (старт/конец смены) теперь тоже часть стандартного графика по дням недели
// (master_weekly_schedule), не только перерыв/выходной. Явная правка одного дня
// (owner напрямую через POST /schedule, или одобренный разовый отгул/отпуск через
// applyScheduleDay) всегда побеждает стандартный график - так и "редактировать на
// конкретный день" уже работает само, без отдельного механизма override.
export async function getEffectiveSchedule(client, masterId, date) {
  const shiftRes = await client.query(
    `SELECT ss.start_time, ss.end_time, sb.start_time AS b_start, sb.end_time AS b_end
     FROM schedule_shifts ss
     LEFT JOIN schedule_breaks sb ON sb.shift_id = ss.id
     WHERE ss.master_id = $1 AND ss.date = $2`,
    [masterId, date]
  );
  if (shiftRes.rows.length > 0) {
    const { start_time: startTime, end_time: endTime } = shiftRes.rows[0];
    const breaks = shiftRes.rows.filter((r) => r.b_start).map((r) => ({ startTime: r.b_start, endTime: r.b_end }));
    return { startTime, endTime, breaks };
  }
  const weekday = isoWeekday(date);
  const weeklyRes = await client.query(
    `SELECT is_working, work_start, work_end, break_start, break_end
     FROM master_weekly_schedule WHERE master_id = $1 AND weekday = $2`,
    [masterId, weekday]
  );
  if (weeklyRes.rows.length === 0) {
    return { startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END, breaks: [] };
  }
  const row = weeklyRes.rows[0];
  if (!row.is_working) {
    return { startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END, breaks: [{ startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END }] };
  }
  const breaks = row.break_start ? [{ startTime: row.break_start, endTime: row.break_end }] : [];
  return { startTime: row.work_start, endTime: row.work_end, breaks };
}

// Окно 22 (04.08.2026, Задача 1) - чистая функция, вынесена из GET /staff, чтобы
// покрыть unit-тестом без реального Postgres (тот же приём, что уже применяется для
// getEffectiveSchedule/isScheduleDayOff выше). viewerRole==='owner' видит всех
// (+ hasWorkingSchedule на каждой строке-мастере, чтобы владелец сам увидел, кому
// нужно донастроить график). Администратор тоже видит весь состав своей точки,
// включая сотрудника без графика, но получает явный hasWorkingSchedule=false,
// чтобы календарь и создание записи могли отдельно исключить его. Мастер видит
// только себя. Не-мастеров фильтр не касается.
export function filterStaffForViewer(staffRows, viewerRole, scheduledMasterIds) {
  if (viewerRole === 'owner' || viewerRole === 'admin') {
    return staffRows.map((r) => (r.providesServices ? { ...r, hasWorkingSchedule: scheduledMasterIds.has(r.id) } : r));
  }
  return staffRows.filter((r) => !r.providesServices || scheduledMasterIds.has(r.id));
}

// Задача C промпта Окна 29 (05.08.2026) - единый источник истины "у мастера есть
// хотя бы один рабочий день в стандартном графике", тот же критерий, что уже
// использует Окно 22 (hasWorkingSchedule) для CRM. Раньше эта проверка жила только
// в GET /staff (видимость в CRM) - публичный клиентский виджет её не знал вообще
// (берёт мастеров из статичного storage.js MASTERS[], GET /staff не вызывает), и
// POST /bookings её тоже не проверял - живой repro 05.08.2026: запись к мастеру без
// единой is_working=true строки создавалась (HTTP 200). Теперь одна функция служит
// трём местам: GET /staff (CRM), GET /masters-next-availability (публичный виджет,
// фильтр списка выбора) и createBookingTx (финальный рубеж, задача C.1).
export async function mastersWithWorkingSchedule(client, masterIds) {
  if (masterIds.length === 0) return new Set();
  const res = await client.query(
    `SELECT DISTINCT master_id FROM master_weekly_schedule WHERE master_id = ANY($1) AND is_working = true`,
    [masterIds]
  );
  return new Set(res.rows.map((r) => r.master_id));
}

// Второй, независимый критерий бронируемости: сотрудник вообще принимает клиентов
// (staff.provides_services). График и приём клиентов - разные вещи: у администратора
// или у мастера, временно снятого с приёма, недельный график остаётся заполненным,
// поэтому проверка выше его пропускает. Живой repro 13.08.2026: у Мамедхана снят
// "Принимает клиентов", а POST /bookings на его id отвечал 200 и создавал запись.
export async function masterAcceptsClients(client, masterId) {
  const res = await client.query(
    'SELECT 1 FROM staff WHERE id = $1 AND employed = true AND provides_services = true',
    [masterId]
  );
  return res.rowCount > 0;
}

// Единое представление "занятого" времени дня - до начала смены, после конца смены
// и сами перерывы - как один список интервалов. Позволяет и createBookingTx, и
// findScheduleConflicts проверять пересечение брони с ЛЮБОЙ причиной блокировки
// одной и той же функцией (intervalsOverlap), не дублируя отдельную проверку границ
// рабочего окна.
export function blockedIntervalsFor(schedule) {
  return [
    { startTime: '00:00', endTime: schedule.startTime },
    { startTime: schedule.endTime, endTime: '23:59' },
    ...schedule.breaks,
  ].filter((b) => b.startTime < b.endTime);
}

// Окно 21 (04.08.2026) - есть ли хотя бы один непрерывный промежуток длиной
// durationMin, свободный от блокировок (рабочее окно + перерывы из
// blockedIntervalsFor + непогашенные брони этого дня). Прямой анализ отсортированных
// интервалов вместо перебора каждого 15-минутного шага (как делает клиентский
// storage.js getFreeSlots) - GET /schedule-availability отвечает true/false сразу
// на до 31 дату диапазона, перебор был бы избыточен на эту нагрузку.
export function hasAvailableSlot(schedule, bookings, durationMin) {
  const blocked = [...blockedIntervalsFor(schedule), ...bookings.filter((b) => b.status !== 'cancelled')]
    .map((b) => ({ start: toMinutes(b.startTime), end: toMinutes(b.endTime) }))
    .filter((b) => b.start < b.end)
    .sort((a, b) => a.start - b.start);

  const dayEnd = 24 * 60;
  let cursor = 0;
  for (const b of blocked) {
    if (b.start > cursor && b.start - cursor >= durationMin) return true;
    cursor = Math.max(cursor, b.end);
  }
  return dayEnd - cursor >= durationMin;
}

// Окно 17 (04.08.2026) - GET /schedule-range (Задача 1). "Выходной день" в рамках
// эффективного графика ОДНОГО дня - когда хотя бы один перерыв целиком покрывает
// реальное рабочее окно этого дня (schedule.startTime/endTime из getEffectiveSchedule,
// не фиксированные 10:00-20:00 - в отличие от assets/crm-calendar.js:44-49, где окно
// календаря всегда 10:00-20:00, здесь рабочее окно у разных мастеров/дней уже может
// отличаться после Окна 16). Тот же принцип проверки (перерыв ⊇ весь день), просто
// применён к фактическим границам дня, а не к константе экрана.
export function isScheduleDayOff(schedule) {
  return schedule.breaks.some(
    (b) => toMinutes(b.startTime) <= toMinutes(schedule.startTime) && toMinutes(b.endTime) >= toMinutes(schedule.endTime)
  );
}

export const SCHEDULE_RANGE_MAX_DAYS = 62; // чуть больше 2 месяцев - масштаб, о котором Влад говорил про YClients

// Число дней в диапазоне [from, to] включительно. NaN, если даты некорректны.
export function rangeDayCount(from, to) {
  const fromMs = new Date(`${from}T00:00:00Z`).getTime();
  const toMs = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return NaN;
  return Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
}

// Эффективный график на каждый день диапазона одним проходом - цикл вокруг уже
// проверенного резолвера getEffectiveSchedule (разовая правка → недельный график →
// глобальный дефолт), логику резолва не дублирует.
export async function computeScheduleRangeDays(client, masterId, from, to) {
  const days = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const eff = await getEffectiveSchedule(client, masterId, dateStr);
    days.push({
      date: dateStr,
      startTime: eff.startTime,
      endTime: eff.endTime,
      breaks: eff.breaks,
      isDayOff: isScheduleDayOff(eff),
    });
  }
  return days;
}

// Окно 21 (04.08.2026) - разумный максимум диапазона для GET /schedule-availability.
// Фронтенд вызывает по одному видимому месяцу календаря, 31 дня достаточно на любой
// месяц с запасом.
export const SCHEDULE_AVAILABILITY_MAX_DAYS = 31;

// Эффективный график + брони каждого дня диапазона одним проходом - брони забираются
// ОДНИМ запросом на весь диапазон (тот же принцип экономии, что уже применён у GET
// /bookings?from=&to=, см. listBookingsForRequest выше), не по одному дню, чтобы не
// плодить до 31 отдельного запроса к bookings. Только занятость слота (start/end/
// status), без клиентских данных - тот же принцип приватности, что уже применён у
// анонимного GET /schedule (см. комментарий там же).
export async function computeAvailabilityRangeDays(client, masterId, durationMin, from, to) {
  const bookingsRes = await client.query(
    `SELECT date, start_time AS "startTime", end_time AS "endTime", status
     FROM bookings WHERE master_id = $1 AND date >= $2 AND date <= $3`,
    [masterId, from, to]
  );
  const bookingsByDate = new Map();
  for (const row of bookingsRes.rows) {
    const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date;
    if (!bookingsByDate.has(dateStr)) bookingsByDate.set(dateStr, []);
    bookingsByDate.get(dateStr).push({ startTime: row.startTime, endTime: row.endTime, status: row.status });
  }

  const days = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const eff = await getEffectiveSchedule(client, masterId, dateStr);
    const dayBookings = bookingsByDate.get(dateStr) ?? [];
    days.push({ date: dateStr, hasSlots: hasAvailableSlot(eff, dayBookings, durationMin) });
  }
  return days;
}

// Окно 26 (04.08.2026) - окно поиска "ближайшая доступная дата", то же [сегодня;
// +60 дней], что и MAX_BOOKING_DAYS_AHEAD на фронтенде (app.js) - дата за пределами
// этого окна для клиента всё равно недостижима кликом по календарю.
export const MASTER_NEXT_AVAILABILITY_WINDOW_DAYS = 60;

// Окно 26 (04.08.2026, Задача 1) - "ближайшая доступная дата" мастера для карточки
// в публичном виджете (Задача 2 того же промпта). Переиспользует hasAvailableSlot +
// getEffectiveSchedule (Окно 21/16) - тот же цикл по дням диапазона, что и
// computeAvailabilityRangeDays, но с ранним выходом на первый найденный день
// (карточка мастера сравнивает "занят/свободен", не строит календарь на весь
// диапазон) и без параллельного накопления результата по каждому дню. durationMin
// здесь - МИНИМАЛЬНАЯ длительность среди услуг мастера (см. вызывающий эндпоинт) -
// hasAvailableSlot монотонна по durationMin (более короткая услуга помещается везде,
// где помещается более длинная), поэтому "доступен хотя бы для одной услуги" ⟺
// "доступен для самой короткой услуги", проверять каждую услугу отдельно не нужно.
export async function computeMasterNextAvailability(client, masterId, durationMin, from, to) {
  const bookingsRes = await client.query(
    `SELECT date, start_time AS "startTime", end_time AS "endTime", status
     FROM bookings WHERE master_id = $1 AND date >= $2 AND date <= $3`,
    [masterId, from, to]
  );
  const bookingsByDate = new Map();
  for (const row of bookingsRes.rows) {
    const dateStr = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date;
    if (!bookingsByDate.has(dateStr)) bookingsByDate.set(dateStr, []);
    bookingsByDate.get(dateStr).push({ startTime: row.startTime, endTime: row.endTime, status: row.status });
  }

  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const eff = await getEffectiveSchedule(client, masterId, dateStr);
    const dayBookings = bookingsByDate.get(dateStr) ?? [];
    if (hasAvailableSlot(eff, dayBookings, durationMin)) return dateStr;
  }
  return null;
}

// Окно 16 (03.08.2026) - валидирует payload единого блока "График работы" (владелец
// PUT /master-weekly-schedule напрямую, или мастер POST /schedule-requests с
// category=grafik_standard - обе ветки шлют один и тот же формат). Возвращает null,
// если payload некорректен (вызывающий код отвечает 400), иначе нормализованный
// массив строк (лишние поля обнулены - is_working=false никогда не хранит рабочее
// окно/перерыв, это же гарантирует и CHECK на уровне таблицы).
// Правка 17.08.2026 - вместе с суточными опциями времени в CRM (00:00-23:59, задача
// Влада «круглосуточный график») добавлена проверка ПОРЯДКА времён. Раньше её не было
// вообще: CHECK в миграции 022 следит только за заполненностью, и график вида
// 23:00-01:00 сохранялся молча - мастер после этого просто выпадал из записи
// (hasAvailableSlot не находит ни одного слота в перевёрнутом окне), нигде не появляясь
// как ошибка. В прежнем списке 10:00-20:00 перепутать порядок было почти невозможно,
// в суточном - соседние по смыслу «ночные» значения стоят на разных концах списка.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function timeToMinutes(value) {
  const m = TIME_RE.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function validateWeeklyChanges(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const seen = new Set();
  const rows = [];
  for (const c of input) {
    if (!Number.isInteger(c?.weekday) || c.weekday < 1 || c.weekday > 7 || seen.has(c.weekday)) return null;
    seen.add(c.weekday);
    const isWorking = !!c.isWorking;
    if (isWorking && (!c.workStart || !c.workEnd)) return null;
    if (!!c.breakStart !== !!c.breakEnd) return null;
    if (isWorking) {
      const workStart = timeToMinutes(c.workStart);
      const workEnd = timeToMinutes(c.workEnd);
      if (workStart == null || workEnd == null || workEnd <= workStart) return null;
      if (c.breakStart) {
        const breakStart = timeToMinutes(c.breakStart);
        const breakEnd = timeToMinutes(c.breakEnd);
        // Перерыв вне смены не блокирует ничего (getEffectiveSchedule считает пересечения
        // внутри окна) и при этом читается человеком как настроенный - тихая пустышка
        if (breakStart == null || breakEnd == null || breakEnd <= breakStart) return null;
        if (breakStart < workStart || breakEnd > workEnd) return null;
      }
    }
    rows.push({
      weekday: c.weekday,
      isWorking,
      workStart: isWorking ? c.workStart : null,
      workEnd: isWorking ? c.workEnd : null,
      breakStart: isWorking && c.breakStart ? c.breakStart : null,
      breakEnd: isWorking && c.breakEnd ? c.breakEnd : null,
    });
  }
  return rows;
}

// Полная замена недельного графика мастера - удаляем все прежние строки и пишем
// присланные заново (не upsert по дням: массив weeklyChanges - это ВЕСЬ график,
// который прислал клиент, дни, отсутствующие в массиве, откатываются на глобальный
// дефолт 10:00-20:00, см. getEffectiveSchedule).
export async function writeWeeklySchedule(client, masterId, rows) {
  await client.query('DELETE FROM master_weekly_schedule WHERE master_id = $1', [masterId]);
  for (const r of rows) {
    await client.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end, break_start, break_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [masterId, r.weekday, r.isWorking, r.workStart, r.workEnd, r.breakStart, r.breakEnd]
    );
  }
}

const WEEKDAY_LABEL = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export function formatWeeklyChangesSummary(rows) {
  return [...rows]
    .sort((a, b) => a.weekday - b.weekday)
    .map((r) => {
      if (!r.isWorking) return `${WEEKDAY_LABEL[r.weekday - 1]} выходной`;
      const brk = r.breakStart ? ` (перерыв ${r.breakStart}–${r.breakEnd})` : '';
      return `${WEEKDAY_LABEL[r.weekday - 1]} ${r.workStart}–${r.workEnd}${brk}`;
    })
    .join(', ');
}

// Новый график может сузить рабочее окно или добавить перерыв на день, где у
// мастера уже есть реальные записи клиентов дальше в будущем - тот же принцип, что
// уже был у "стандартного" правила (RECURRING_CONFLICT_LOOKAHEAD_DAYS вперёd), но
// теперь через единый blockedIntervalsFor (окно + перерыв, не только перерыв).
// Дни, где на конкретную дату уже есть явная разовая правка (schedule_shifts),
// пропускаем - там всё равно побеждает не недельный график, а эта правка (см.
// getEffectiveSchedule), реального конфликта с НОВЫМ графиком там нет.
export async function findWeeklyScheduleConflicts(client, masterId, rows) {
  const changedByWeekday = new Map(rows.map((r) => [r.weekday, r]));
  const conflictsByDate = [];
  const { date: todayStr } = shopNow();
  for (let d = new Date(`${todayStr}T00:00:00Z`), i = 0; i < RECURRING_CONFLICT_LOOKAHEAD_DAYS; d.setUTCDate(d.getUTCDate() + 1), i++) {
    const dateStr = d.toISOString().slice(0, 10);
    const change = changedByWeekday.get(isoWeekday(dateStr));
    if (!change) continue;
    const hasOverride = (await client.query('SELECT 1 FROM schedule_shifts WHERE master_id = $1 AND date = $2', [masterId, dateStr])).rows.length > 0;
    if (hasOverride) continue;
    const schedule = change.isWorking
      ? { startTime: change.workStart, endTime: change.workEnd, breaks: change.breakStart ? [{ startTime: change.breakStart, endTime: change.breakEnd }] : [] }
      : { startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END, breaks: [{ startTime: GLOBAL_DEFAULT_START, endTime: GLOBAL_DEFAULT_END }] };
    const conflicts = await findScheduleConflicts(client, masterId, dateStr, blockedIntervalsFor(schedule));
    if (conflicts.length) conflictsByDate.push({ date: dateStr, conflicts });
  }
  return conflictsByDate;
}

// Влад (03.08.2026) - если ставится перерыв/выходной на время, где у мастера уже
// есть реальная запись клиента, раньше об этом никто не узнавал (бронь просто
// оставалась "в силе" рядом с новым перерывом - клиент бы просто не застал
// мастера). Возвращает список пересекающихся броней с именем/телефоном клиента -
// вызывающий код решает, кого уведомить (см. notifications_type_check, миграция
// 019 добавляет тип 'schedule_conflict').
export async function findScheduleConflicts(client, masterId, date, breaks) {
  if (!breaks.length) return [];
  // COALESCE - тот же приём, что в listBookingsForRequest (api/routes/bookings.js) -
  // клиент без телефона (walkin_name, миграция 041) тоже виден в тексте уведомления
  // о конфликте, не только клиенты с карточкой в clients.
  const bookingsRes = await client.query(
    `SELECT b.start_time, b.end_time, COALESCE(c.name, b.walkin_name) AS client_name, c.phone AS client_phone
     FROM bookings b LEFT JOIN clients c ON c.id = b.client_id
     WHERE b.master_id = $1 AND b.date = $2 AND b.status != 'cancelled'`,
    [masterId, date]
  );
  return bookingsRes.rows.filter((b) =>
    breaks.some((br) => intervalsOverlap(br.startTime, br.endTime, b.start_time, b.end_time))
  );
}

// Задача 3 (Окно 14, 02.08.2026) - применяет одобренный перерыв/выходной к графику
// ОДНОГО дня. В отличие от POST /schedule (server.mjs, обработчик ниже), который
// перед вставкой удаляет ВСЕ перерывы дня целиком (транзакционная замена) - здесь
// только ДОБАВЛЯЕМ новый интервал поверх уже сохранённых, ничего не стирая. Для
// day_off (весь день) используем временный дефолт рабочего окна 10:00-20:00 (тот же,
// что storage.js:14-18) - в схеме staff пока нет своих default_start_time/end_time
// на сотрудника, заводить miграцию под это не стали (см. Ограничения промпта).
export async function applyScheduleDay(client, masterId, date, startTime, endTime) {
  const shiftRes = await client.query(
    `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, $2, '10:00', '20:00')
     ON CONFLICT (master_id, date) DO UPDATE SET master_id = EXCLUDED.master_id
     RETURNING id`,
    [masterId, date]
  );
  const shiftId = shiftRes.rows[0].id;
  await client.query('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [
    shiftId,
    startTime,
    endTime,
  ]);
}

// ── Праздники (Окно 24, 05.08.2026) ────────────────────────────────────────
// Производственный календарь как данные (таблица holidays, миграция 034) вместо
// 12 захардкоженных строк во вкладке "Год". Праздничность даты и рабочий статус дня
// у мастера - два НЕЗАВИСИМЫХ признака: мастер может сам выйти работать 23 февраля,
// день останется рабочим, но праздником быть не перестанет. Поэтому holidays ничего
// не знает про мастеров, а schedule_shifts ничего не знает про праздники - связывает
// их только явное действие владельца (POST /holidays/close).
export async function listHolidays(client, year) {
  const res = await client.query(
    'SELECT date, name FROM holidays WHERE EXTRACT(YEAR FROM date) = $1 ORDER BY date',
    [year]
  );
  return res.rows.map((r) => ({ date: dateColToStr(r.date), name: r.name }));
}

// Кого закрываем: без явного списка - всех, кто реально принимает клиентов
// (provides_services, тот же признак, по которому мастера попадают в публичный
// виджет), уволенных не трогаем. Явный список сужает выборку и заодно отсеивает
// несуществующие id - молча, потому что для владельца это не ошибка ввода: список
// приходит из его же интерфейса, а мастер мог быть уволен в соседней вкладке.
export async function holidayCloseTargets(client, masterIds) {
  const res = await client.query('SELECT id FROM staff WHERE employed = true AND provides_services = true');
  const all = res.rows.map((r) => r.id);
  if (masterIds == null) return all;
  const requested = new Set(masterIds);
  return all.filter((id) => requested.has(id));
}

// Границы перерыва, которым день закрывается ЦЕЛИКОМ (праздник, отгул, отпуск).
// Фиксированной пары 10:00-20:00 здесь НЕ достаточно: applyScheduleDay создаёт смену
// 10:00-20:00 только если строки в schedule_shifts ещё нет, а на уже существующей
// смене (например разовая правка 09:00-18:00) оставляет её окно нетронутым. Перерыв
// 10:00-20:00 такую смену не накрывает слева, isScheduleDayOff вернул бы false и день
// остался бы "рабочим с длинным перерывом" - ровно то, чего никто не ожидает, закрывая
// день. Берём объединение эффективного окна мастера и того, что может создать сама
// applyScheduleDay.
//
// Баг, который это чинит (найден и воспроизведён 05.08.2026 на локальной базе):
// одобренный отгул (PATCH /schedule-requests/:id/decision) ставил перерыв литералами
// '10:00'/'20:00' - у мастера со сменой 09:00-18:00 день после одобрения оставался
// isDayOff:false, а /schedule-availability отдавал hasSlots:true, то есть клиент мог
// записаться в уже одобренный отгул на 09:00-10:00. Роут при этом отвечал 200.
export function fullDayOffWindow(effectiveSchedule) {
  const startTime = toMinutes(effectiveSchedule.startTime) < toMinutes(GLOBAL_DEFAULT_START)
    ? effectiveSchedule.startTime
    : GLOBAL_DEFAULT_START;
  const endTime = toMinutes(effectiveSchedule.endTime) > toMinutes(GLOBAL_DEFAULT_END)
    ? effectiveSchedule.endTime
    : GLOBAL_DEFAULT_END;
  return { startTime, endTime };
}

// Окна блокировки по каждой дате одобряемой заявки мастера (PATCH /schedule-requests/
// :id/decision). Разведено по типу заявки:
//   day_off - весь день, границы считаются от РЕАЛЬНОГО графика мастера на эту дату
//             (fullDayOffWindow), а не литералами 10:00-20:00. Даты диапазона считаются
//             по одной: у мастера может быть разный график в разные дни отпуска.
//   break   - конкретные часы, которые мастер сам указал в заявке, их и блокируем.
// Одна и та же карта используется дважды - сначала для поиска конфликтов с бронями,
// потом для применения: считать окна повторно нельзя, иначе проверка и запись могли бы
// разойтись.
export async function dayOffWindowsForRequest(client, masterId, dates, requestType, startTime, endTime) {
  const windows = new Map();
  for (const dateStr of dates) {
    if (requestType === 'day_off') {
      windows.set(dateStr, fullDayOffWindow(await getEffectiveSchedule(client, masterId, dateStr)));
    } else {
      windows.set(dateStr, { startTime, endTime });
    }
  }
  return windows;
}

// Что именно произойдёт при массовом закрытии - считается ДО записи, отдельно от неё
// (роут применяет план в транзакции). Три исхода на пару мастер+дата:
//   closed    - закрываем (в ответе видно, каким окном)
//   skipped   - мастер на эту дату уже выходной; повторный applyScheduleDay положил бы
//               второй такой же перерыв поверх, дубль в графике без всякой пользы
//   conflicts - на дате есть живая бронь; такую дату НЕ трогаем вовсе
// Про конфликты: правило проекта - не ломать живую бронь молча (POST /schedule отвечает
// 409, см. решение Влада от 04.08.2026). Но отказывать во ВСЁМ диапазоне из-за одной
// брони здесь было бы хуже: единственная запись 8 марта заблокировала бы закрытие всех
// январских дат всем мастерам. Поэтому закрываем что можем, конфликтные пары возвращаем
// владельцу списком - он решает по каждой (перенести клиента или оставить день рабочим).
export async function planHolidayClose(client, masterIds, dates) {
  const closed = [];
  const skipped = [];
  const conflicts = [];
  for (const masterId of masterIds) {
    for (const date of dates) {
      const eff = await getEffectiveSchedule(client, masterId, date);
      if (isScheduleDayOff(eff)) {
        skipped.push({ masterId, date, reason: 'already_day_off' });
        continue;
      }
      const window = fullDayOffWindow(eff);
      const dayConflicts = await findScheduleConflicts(client, masterId, date, [window]);
      if (dayConflicts.length) {
        conflicts.push({ masterId, date, conflicts: dayConflicts });
        continue;
      }
      closed.push({ masterId, date, startTime: window.startTime, endTime: window.endTime });
    }
  }
  return { closed, skipped, conflicts };
}

// Разумный максимум одного массового закрытия - календарный год. Больше владельцу
// незачем (таблица праздников ведётся по годам), а без потолка один запрос мог бы
// перебрать произвольное число дат × мастеров.
export const HOLIDAY_CLOSE_MAX_DAYS = 366;
