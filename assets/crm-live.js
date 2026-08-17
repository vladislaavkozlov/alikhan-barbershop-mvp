// Живое обновление кабинета (17.08.2026, задача Влада: «при создании записи она просто
// мгновенно должна появляться у всех», «не нужно проверять на чужие записи каждую
// секунду - нужно, чтобы из источника записи шёл мгновенный пуш», «не нужно, чтобы ВЕСЬ
// кабинет обновлялся - нужно мгновенное появление новой записи в календаре»).
//
// Как работает. Сервер держит поток событий (GET /events, api/lib/events.js) и в момент
// изменения сам шлёт короткую строчку всем открытым кабинетам - никто ничего не
// опрашивает. Кабинет на событие о новой записи вставляет ОДНУ карточку в календарь
// (window.__insertDayBooking → upsertDayBooking, assets/crm-calendar.js), не перерисовывая
// ни день целиком, ни тем более остальные разделы.
//
// Почему не EventSource, а fetch со стримом: EventSource не умеет передавать заголовок
// Authorization, пришлось бы класть токен в адрес - он бы светился в логах прокси и в
// истории браузера. fetch с ReadableStream заголовки умеет, формат потока читаем тот же.
//
// История, чтобы не ходить по кругу. Поток уже включали утром 17.08.2026 и сняли в тот
// же день (коммит 3335072) в пользу опроса раз в 3 секунды: кабинет ловил плавающий баг
// «раздел Команда то рисуется, то нет», и причиной сочли лимит браузера в шесть
// одновременных соединений на домен. Замер перед этой правкой: API отвечает по HTTP/2
// (`curl -w %{http_version}` → 2), а в HTTP/2 все запросы к домену идут одним
// соединением и лимита шести нет вовсе - значит дело было не в слоте, а в гонке на
// старте: поток присылал событие в момент первичной отрисовки, и renderTeam запускался
// вторым экземпляром поверх незакончившегося первого. Поэтому здесь два предохранителя,
// см. STARTUP_QUIET_MS и applyStaff.
//
// Проверено живьём на боевом API перед правкой: поток проходит через прокси Amvera без
// буферизации (hello приходит мгновенно, ping ровно через 20 секунд).
import { API, getToken } from './crm-auth.js';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// Сколько ждать первую строчку, прежде чем считать поток недоехавшим и включить опрос
const STREAM_GRACE_MS = 8000;
// Опрос - только страховка на случай, когда поток физически не доходит (корпоративный
// фильтр, прокси с буферизацией). При живом потоке не запускается вообще
const FALLBACK_POLL_MS = 15000;
// События приходят пачками (одна операция = несколько строк), поэтому обновляем не на
// каждую, а через короткую паузу - иначе календарь перерисовывался бы по три раза
const DEBOUNCE_MS = 250;
// Тишина после входа: пока кабинет рисуется первый раз, перерисовывать его разделы
// поверх нельзя - именно это давало пустую «Команду». Точечная вставка записи в
// календарь под это правило НЕ подпадает: она ничего не перерисовывает
const STARTUP_QUIET_MS = 3000;

let stopped = false;
let controller = null;
let usingFallback = false;
let streamAlive = false;
let reconnectDelay = RECONNECT_MIN_MS;
let authenticatedAt = 0;
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
// (или кнопка) покажет актуальное.
// Второе условие - та самая гонка первичной отрисовки (см. шапку файла): пока идёт
// STARTUP_QUIET_MS после входа, renderTeam трогать нельзя ни под каким предлогом
async function applyStaff() {
  if (Date.now() - authenticatedAt < STARTUP_QUIET_MS) return;
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
  flushTimer = setTimeout(async () => {
    const types = [...pending];
    pending.clear();
    for (const item of types) {
      try {
        await APPLY[item]();
      } catch {
        // Одна упавшая перерисовка не должна отменять остальные и рвать поток
      }
    }
  }, DEBOUNCE_MS);
}

// ── Новая запись: та самая мгновенная вставка ────────────────────────────────
// Событие несёт только id/дату/мастера, самих данных брони в нём нет - и намеренно:
// поток идёт всем открытым кабинетам, а имя и телефон клиента видеть должны не все.
// Поэтому запись забираем обычным роутом, где сервер проверяет права роли (мастер
// чужую точку так и не увидит), и вставляем одну карточку.
async function insertNewBooking(event) {
  const token = getToken();
  if (!token || !event.bookingId || !event.date) return false;
  try {
    const res = await fetch(`${API}/bookings?date=${encodeURIComponent(event.date)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const body = await res.json();
    const booking = (body.bookings ?? []).find((b) => b.id === event.bookingId);
    // Записи нет в ответе - значит эта роль её видеть не должна (чужая точка), и
    // перерисовывать день ради неё тоже не надо: для этого кабинета не изменилось ничего
    if (!booking) return true;
    return window.__insertDayBooking?.(booking) === true;
  } catch {
    return false;
  }
}

// Приход события. Всё, что не «создана новая запись», идёт прежним путём - перечитать
// затронутый раздел: перенос, отмена и смена статуса меняют не только карточку, но и
// цифры выручки/зарплаты, а таких событий за день единицы
async function handleEvent(event) {
  if (event.type === 'bookings' && event.reason === 'created') {
    const shown = await insertNewBooking(event);
    if (shown) {
      // И на этом всё. Никаких «заодно перечитаем кабинет»: window.__refreshOwnerDashboard
      // (crm-owner.html) - это алерты, риски, заявки на график, графики всей команды и
      // финансы, шестнадцать запросов на одну появившуюся карточку (замерено живым
      // прогоном 17.08.2026). Новая запись всегда создаётся со статусом «ожидание», в
      // выручку дня она не попадает, так что и обновлять там нечего.
      // Единственное исключение - «Выручка сегодня» у администратора: один дешёвый
      // запрос, и он покрывает случай, когда запись сразу закрыл walk-in-ом другой
      // администратор на той же точке
      window.__refreshRoleSnapshot?.();
      return;
    }
    // Точечно не вышло (открыт другой день, у мастера выходной, сеть моргнула) -
    // честно перерисовываем расписание, лучше лишняя перерисовка, чем пропавшая запись
  }
  scheduleApply(event.type);
}

function handleLine(line) {
  if (!line.startsWith('data:')) return; // ': ping' - строка жизни канала, не событие
  try {
    const event = JSON.parse(line.slice(5).trim());
    if (event.type === 'hello') return;
    handleEvent(event);
  } catch {
    // Обрезанная строка на границе пакета - следующая придёт целиком
  }
}

// ── Поток событий ────────────────────────────────────────────────────────────
async function connectStream() {
  const token = getToken();
  if (!token || stopped) return;
  controller = new AbortController();
  // Если первая строчка не пришла за STREAM_GRACE_MS - поток до нас не доезжает,
  // поднимаем опрос-страховку (сам поток при этом продолжаем пытаться держать)
  const graceTimer = setTimeout(() => {
    if (!streamAlive) startFallbackPolling();
  }, STREAM_GRACE_MS);
  try {
    const res = await fetch(`${API}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!streamAlive) {
        streamAlive = true;
        reconnectDelay = RECONNECT_MIN_MS;
        stopFallbackPolling();
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // последний кусок может быть обрезан на границе пакета
      lines.forEach((line) => handleLine(line.trim()));
    }
  } catch {
    // Обрыв - переподключаемся ниже. Сеть моргнула, прокси закрыл, вкладка уснула
  } finally {
    clearTimeout(graceTimer);
    streamAlive = false;
  }
  if (stopped) return;
  // Пока соединения не было, что-то могло измениться - догоняем одним запросом
  await pollOnce({ apply: true });
  setTimeout(connectStream, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// ── Опрос-страховка ──────────────────────────────────────────────────────────
// Сравнивает отметки времени последних изменений с прошлым ответом и дёргает ровно те
// обновлялки, чьи отметки сдвинулись. Сервер отдаёт четыре числа - это весь трафик
async function pollOnce({ apply = true } = {}) {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch(`${API}/changes`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const next = await res.json();
    if (lastChanges && apply) {
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
function startFallbackPolling() {
  if (pollTimer || stopped) return;
  usingFallback = true;
  pollOnce({ apply: false }); // первая отметка - точка отсчёта, применять нечего
  pollTimer = setInterval(() => {
    if (!stopped) pollOnce();
  }, FALLBACK_POLL_MS);
}

function stopFallbackPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  usingFallback = false;
}

// Возврат на вкладку. Раньше здесь дёргались ВСЕ обновлялки сразу - и это ловилось
// живьём как гонка: браузер шлёт visibilitychange и в момент первой отрисовки страницы,
// так что renderTeam запускалась вторым параллельным экземпляром поверх ещё не
// закончившегося первого, и раздел «Команда» иногда оставался пустым (17.08.2026,
// поймано прод-прогоном сразу после выкатки живого обновления). Теперь: обновляем
// только по настоящему ВОЗВРАЩЕНИЮ (вкладка была скрыта), и только расписание с
// уведомлениями - за командой сходит своё событие, ей внеплановая перерисовка не нужна.
// Мобильный браузер вдобавок морозит фоновые вкладки вместе с потоком, поэтому здесь же
// проверяем, жив ли он, и переподключаемся, если нет
let wasHidden = false;
document.addEventListener('visibilitychange', () => {
  if (stopped) return;
  if (document.visibilityState !== 'visible') { wasHidden = true; return; }
  if (!wasHidden) return;
  wasHidden = false;
  scheduleApply('bookings');
  scheduleApply('notifications');
  if (!streamAlive && !usingFallback) connectStream();
});

// После входа подключаемся: до него нет токена, а значит и права слушать
document.addEventListener('crm:authenticated', () => {
  stopped = false;
  authenticatedAt = Date.now();
  connectStream();
});

// pagehide надёжнее beforeunload: он приходит и при переходе назад/вперёд, и на мобильных,
// где beforeunload часто не срабатывает вовсе. Соединение надо именно ОБОРВАТЬ, а не
// пометить флагом: живой замер 17.08.2026 показал 7 висящих подписчиков на сервере после
// четырёх входов подряд - брошенные потоки копились, потому что вкладка ушла, а
// соединение осталось
function stopLive() {
  stopped = true;
  stopFallbackPolling();
  try {
    controller?.abort();
  } catch {
    // соединение уже закрыто - ничего не делаем
  }
  controller = null;
}
window.addEventListener('pagehide', stopLive);
window.addEventListener('beforeunload', stopLive);
