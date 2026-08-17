// Живое обновление кабинета (17.08.2026, задача Влада: «запись при создании должна
// появляться в расписании моментально без обновлений... бесшовно и мгновенно» и
// «сделай так, чтобы без каких-либо действий работало»).
//
// Замер до правки (tools/diag-2026-08-17-zhivoe-obnovlenie.mjs): кабинет, открытый на
// расписании, не замечал чужую новую запись и через 15 секунд - она появлялась только
// после нажатия «Обновить».
//
// Как работает. Сервер держит поток событий (GET /events, api/lib/events.js) и шлёт
// короткую строчку на каждое изменение броней, графика, команды или уведомлений.
// Этот модуль слушает поток и дёргает те же обновлялки, что и кнопка «Обновить», но
// точечно - только то, чего касается событие.
//
// Почему не EventSource, а fetch со стримом: EventSource не умеет передавать заголовок
// Authorization, пришлось бы класть токен в адрес - он бы светился в логах прокси и в
// истории браузера. fetch с ReadableStream заголовки умеет, а формат потока читаем тот
// же самый, построчный.
//
// Два обязательных предохранителя:
//   1. Переподключение с нарастающей паузой - между браузером и Node стоит прокси
//      Amvera, он может закрыть долгое соединение в любой момент.
//   2. Фолбэк на опрос GET /changes - если поток не доживает до браузера вообще
//      (буферизация прокси, корпоративный фильтр), кабинет всё равно обновляется,
//      просто с задержкой в несколько секунд, а не мгновенно.
import { API, getToken } from './crm-auth.js';

// Опрос раз в 3 секунды. Изначально здесь был поток событий (SSE) ради мгновенности, и
// он работал - запись появлялась за 0.8 секунды. Но живое соединение занимает один из
// шести слотов, которые браузер отводит на домен, и это ловилось на проде как плавающий
// баг: раздел «Команда» то рисуется, то нет, потому что запрос за составом команды
// вставал в очередь за висящим потоком. Три секунды задержки - честная цена за то, что
// кабинет грузится предсказуемо. Запрос дешёвый: четыре числа, без данных.
// События приходят пачками (одна операция = несколько строк), поэтому обновляем не на
// каждую, а через короткую паузу - иначе календарь перерисовывался бы по три раза
const POLL_MS = 3000;
const DEBOUNCE_MS = 250;
// Новая запись - то, ради чего всё затевалось: её ждут глазами, поэтому пачку событий
// о бронях склеиваем короче, чем остальные
const DEBOUNCE_BOOKINGS_MS = 60;

let stopped = false;
let lastChanges = null;
const pending = new Set();
let flushTimer = null;

// Обновлялки те же, что у кнопки «Обновить» (assets/crm-refresh-control.js) - здесь
// они разложены по видам событий, чтобы новая запись не перерисовывала заодно карточки
// команды, а правка карточки не дёргала календарь без нужды
// { all: true } обязателен, и вот почему (проверено живьём 17.08.2026, я на этом уже
// ошибся). Попробовал убрать флаг ради скорости - расписание перестало обновляться
// вовсе. Причина в refresh() (assets/crm-schedule-views.js): без флага он перечитывает
// только РАСКРЫТЫЕ карточки видов, а у владельца «День», «Неделя» и «Месяц» свёрнуты
// по умолчанию - под условие не попадал ни один, и новая запись не появлялась ни через
// 15 секунд, ни вообще. Сводка и личные цифры при этом уезжают следом, отдельной
// волной, чтобы не задерживать саму карточку в расписании - её человек и ждёт увидеть
async function applyBookings() {
  await window.__refreshScheduleViews?.({ all: true });
  Promise.allSettled([
    window.__refreshRoleSnapshot?.(),
    window.__refreshOwnerDashboard?.(),
  ].filter(Boolean));
}

async function applySchedule() {
  await Promise.allSettled([
    window.__refreshScheduleViews?.({ all: true }),
    window.__refreshTeamSchedules?.(),
  ].filter(Boolean));
}

// Карточки команды перерисовываются из ответа сервера, а это затирает то, что человек
// набрал руками и ещё не сохранил. По кнопке «Обновить» так и задумано (он нажал сам и
// получает предупреждение), но здесь обновление приходит само, без спроса - молча
// стереть чужой набранный текст нельзя. Поэтому если в карточках есть несохранённое,
// команду не трогаем: человек сохранит или уйдёт со страницы, и следующее событие
// (или кнопка) покажет актуальное
async function applyStaff() {
  if (window.__teamHasUnsavedChanges?.() || window.__portfolioHasUnsavedChanges?.()) return;
  await Promise.allSettled([
    window.__refreshTeam?.(),
    window.__refreshScheduleViews?.({ all: true }),
    window.__refreshPortfolioFields?.(),
  ].filter(Boolean));
}

async function applyNotifications() {
  await Promise.allSettled([window.__refreshNotifications?.()].filter(Boolean));
}

const APPLY = {
  bookings: applyBookings,
  schedule: applySchedule,
  staff: applyStaff,
  notifications: applyNotifications,
};

function scheduleApply(type) {
  if (!APPLY[type]) return;
  pending.add(type);
  clearTimeout(flushTimer);
  const wait = pending.has('bookings') ? DEBOUNCE_BOOKINGS_MS : DEBOUNCE_MS;
  flushTimer = setTimeout(async () => {
    const types = [...pending].sort((a, b) => (a === 'bookings' ? -1 : b === 'bookings' ? 1 : 0));
    pending.clear();
    for (const item of types) {
      try {
        await APPLY[item]();
      } catch {
        // Одна упавшая перерисовка не должна отменять остальные
      }
    }
  }, wait);
}

// Сравнивает отметки времени последних изменений с прошлым ответом и дёргает ровно те
// обновлялки, чьи отметки сдвинулись. Сервер отдаёт четыре числа - это весь трафик
async function pollOnce() {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch(`${API}/changes`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const next = await res.json();
    if (lastChanges) {
      for (const [type, at] of Object.entries(next)) {
        if (at !== lastChanges[type]) scheduleApply(type);
      }
    }
    lastChanges = next;
  } catch {
    // Сеть моргнула - следующая попытка через интервал
  }
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(() => {
    if (!stopped) pollOnce();
  }, POLL_MS);
}

// Возврат на вкладку. Раньше здесь дёргались ВСЕ обновлялки сразу - и это ловилось
// живьём как гонка: браузер шлёт visibilitychange и в момент первой отрисовки страницы,
// так что renderTeam запускалась вторым параллельным экземпляром поверх ещё не
// закончившегося первого, и раздел «Команда» иногда оставался пустым (17.08.2026,
// поймано прод-прогоном сразу после выкатки живого обновления). Теперь: обновляем
// только по настоящему ВОЗВРАЩЕНИЮ (вкладка была скрыта), и только расписание с
// уведомлениями - за командой сходит своё событие, ей внеплановая перерисовка не нужна
let wasHidden = false;
document.addEventListener('visibilitychange', () => {
  if (stopped) return;
  if (document.visibilityState !== 'visible') { wasHidden = true; return; }
  if (!wasHidden) return;
  wasHidden = false;
  pollOnce();
  scheduleApply('bookings');
  scheduleApply('notifications');
});

// После входа начинаем опрашивать: до него нет токена, а значит и права спрашивать
document.addEventListener('crm:authenticated', () => {
  stopped = false;
  startPolling();
});

// pagehide надёжнее beforeunload: он приходит и при переходе назад/вперёд, и на мобильных,
// где beforeunload часто не срабатывает вовсе
function stopLive() {
  stopped = true;
  clearInterval(pollTimer);
  pollTimer = null;
}
window.addEventListener('pagehide', stopLive);
window.addEventListener('beforeunload', stopLive);
