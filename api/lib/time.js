// Время/интервалы/даты (те же правила, что storage.js на фронтенде) - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
export function toMinutes(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
export function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
export function addMinutes(time, minutes) {
  return minutesToTime(toMinutes(time) + minutes);
}
// Окно 26 (04.08.2026) - тот же приём UTC-арифметики над "YYYY-MM-DD", что уже
// используется в циклах computeScheduleRangeDays/computeAvailabilityRangeDays выше.
export function addDaysIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  const aS = toMinutes(aStart);
  const aE = toMinutes(aEnd);
  const bS = toMinutes(bStart);
  const bE = toMinutes(bEnd);
  return aS < bE && bS < aE;
}

// Баг Влада (02.08.2026): ничего не мешало забронировать уже прошедшее сегодняшнее
// время (например 10:00, когда на часах 13:38) - ни фронт, ни сервер это не
// проверяли. Все date/time в этой системе - наивные строки в местном времени
// барбершопа (Ставрополь = московское, UTC+3, переводов часов в РФ с 2014 нет,
// см. api/migrations/*) - не полагаемся на часовой пояс самого сервера Amvera
// (неизвестен, может быть UTC), считаем "сейчас" явно со сдвигом +3.
export function shopNow() {
  const shopMs = Date.now() + 3 * 60 * 60 * 1000;
  const d = new Date(shopMs);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return { date, time };
}

// ISO-номер дня недели (1=Пн..7=Вс) для строки "YYYY-MM-DD" - полдень UTC, чтобы
// не словить сдвиг даты на TZ-границе (тот же приём, что уже используется в этом
// файле для дат из Postgres, см. shopNow()/дата-циклы выше).
export function isoWeekday(dateStr) {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

// Окно 23 (04.08.2026) - список дат заявки "с ... по ..." включительно. Раньше этот
// цикл жил инлайном в PATCH /schedule-requests/:id/decision; отмена заявки (PATCH
// .../cancel) обязана пройти РОВНО по тем же датам, что применение - разойдись они,
// часть диапазона осталась бы заблокированной после отмены. Один общий хелпер вместо
// двух копий цикла + покрыт юнит-тестом без Postgres.
export function enumerateDateRange(dateFrom, dateTo) {
  const dates = [];
  for (let d = new Date(`${dateFrom}T00:00:00Z`); d.toISOString().slice(0, 10) <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// Postgres отдаёт `date`-колонки объектом Date (см. комментарий про parseDate в шапке
// файла) - к строке "YYYY-MM-DD" их приводит эта же пара вызовов в нескольких местах.
export function dateColToStr(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
