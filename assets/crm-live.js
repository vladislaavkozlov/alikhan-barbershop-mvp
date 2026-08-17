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

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const FALLBACK_POLL_MS = 5000;
// Сколько ждать первое событие, прежде чем считать поток нерабочим и включить опрос
const STREAM_GRACE_MS = 8000;
// События приходят пачками (одна операция = несколько строк), поэтому обновляем не на
// каждую, а через короткую паузу - иначе календарь перерисовывался бы по три раза
const DEBOUNCE_MS = 250;
// Новая запись - то, ради чего всё затевалось: её ждут глазами, поэтому пачку событий
// о бронях склеиваем короче, чем остальные
const DEBOUNCE_BOOKINGS_MS = 60;

let reconnectDelay = RECONNECT_MIN_MS;
let stopped = false;
let usingFallback = false;
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
        // Одна упавшая перерисовка не должна отменять остальные и рвать поток
      }
    }
  }, wait);
}

function handleLine(line) {
  if (!line.startsWith('data:')) return; // ': ping' - строка жизни канала, не событие
  try {
    const event = JSON.parse(line.slice(5).trim());
    if (event.type === 'hello') return;
    scheduleApply(event.type);
  } catch {
    // Обрезанная строка на границе пакета - следующая придёт целиком
  }
}

// Опрос как запасной путь. Сравнивает отметки времени последних изменений и дёргает
// ровно те обновлялки, чьи отметки сдвинулись
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

function startFallback() {
  if (usingFallback) return;
  usingFallback = true;
  console.info('Живое обновление: поток недоступен, перешёл на опрос раз в 5 секунд');
  pollOnce();
  setInterval(() => {
    if (!stopped) pollOnce();
  }, FALLBACK_POLL_MS);
}

async function connect() {
  const token = getToken();
  if (!token || stopped) return;

  // Если за это время не пришло ни одного байта - поток считаем нерабочим
  const graceTimer = setTimeout(startFallback, STREAM_GRACE_MS);

  try {
    const res = await fetch(`${API}/events`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error(`events ${res.status}`);

    clearTimeout(graceTimer);
    reconnectDelay = RECONNECT_MIN_MS; // соединение удалось - следующая попытка снова быстрая

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Событие заканчивается пустой строкой; всё до неё - целые строки
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) handleLine(part.trim());
    }
  } catch {
    clearTimeout(graceTimer);
  }

  if (stopped) return;
  // Прокси закрыл канал или сеть моргнула - возвращаемся, увеличивая паузу, чтобы не
  // долбить сервер в цикле, если он лежит
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// Вкладку свернули - браузер и так душит фоновые таймеры, а вернувшись, человек должен
// увидеть свежую картинку сразу, не дожидаясь следующего события
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || stopped) return;
  if (usingFallback) pollOnce();
  for (const type of Object.keys(APPLY)) scheduleApply(type);
});

// Поток открываем только после входа: до него нет токена, а значит и права слушать
document.addEventListener('crm:authenticated', () => {
  stopped = false;
  connect();
});

window.addEventListener('beforeunload', () => { stopped = true; });
