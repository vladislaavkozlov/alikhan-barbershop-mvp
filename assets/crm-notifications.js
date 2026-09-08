// Уведомления CRM: колокольчик в шапке + раздел «Уведомления» у владельца.
//
// Что это такое после правки 20.08.2026 (решение Влада). Раньше здесь жила одна общая
// лента на восемь типов - записи, напоминания «за 15 минут», заявки мастеров на отгул,
// «у мастера пропал график» - а пункт меню «Уведомления» показывал совсем другое
// (только заявки на график). Один и тот же человек видел под одним словом две разные
// вещи. Теперь и колокольчик, и раздел показывают ОДНО И ТО ЖЕ - записи клиентов, -
// отличаясь только подробностью:
//
//   колокольчик - быстрый взгляд: последние NN штук, строка на каждую, «показать все»;
//   раздел      - полная карточка: когда, кто, к кому, за чем, плюс два действия -
//                 открыть саму запись в расписании и написать клиенту.
//
// Типов осталось три, все про запись клиента (миграция 051 сузила CHECK до них):
// booking_new (записался, в тот же момент), booking_moved_out (запись ушла к другому
// мастеру), booking_moved_in (запись пришла). Напоминания «за 15 минут»/«время пришло»
// сняты вместе с фоновым сканером - Влад: «нужны уведомления только в момент записи».
//
// Уведомления клиентам (МАКС и прочие мессенджеры) в эту правку НЕ входят - отложены
// до решения по боту. Здесь только связь в один клик руками сотрудника: кнопка
// открывает мессенджер с уже набранным текстом, отправляет человек.
import { goToSection } from './crm-app-shell.js';
import { ICON_BELL, ICON_BOOKING_NEW, ICON_BOOKING_MOVED_IN, ICON_BOOKING_MOVED_OUT, ICON_BOOKING_CANCELLED, ICON_CLOSE } from './crm-icons.js';
// Экранирование берём готовое из crm-schedule-shared.js - та же функция уже защищает
// пять других CRM-файлов, своей копии не заводим. Нужна она здесь по-прежнему: имя
// клиента приезжает из АНОНИМНОГО POST /bookings с публичного сайта (XSS, найденный
// живым прогоном 10.08.2026: clientName = '<img src=x onerror=alert(1)>' доходил до
// списка уведомлений мастера дословно).
import { escapeHtml } from './crm-schedule-shared.js';
import { errorMessage, showError, showInfo } from './crm-toast.js';
import { showSpinner, skeletonMarkup } from './crm-loading.js';
import { T, P, tenantName } from './crm-terms.js';

const TOKEN_KEY = 'alikhan-crm:token';
const API = window.ALIKHAN_API_URL;
const COMPACT_LIMIT = 6; // сколько строк показывает колокольчик, прежде чем отправить в раздел
// Пустой колокольчик объясняет, куда делись убранные строки - иначе «Новых записей нет»
// прочитается как «записей нет вообще», хотя журнал в разделе полон
const emptyBellHtml = () => `<div class="note" style="padding:10px">${P('booking.emptyBell')}</div>`;

// Иконки - штриховые SVG того же набора, что сайдбар и шапка (assets/crm-icons.js),
// не эмодзи: в крупной карточке раздела эмодзи выпадал из общего стиля. Стрелка
// направления сохранена - в списке из десяти строк видно, ушла запись или пришла.
const TYPE_ICON = {
  booking_new: ICON_BOOKING_NEW,
  booking_moved_out: ICON_BOOKING_MOVED_OUT,
  booking_moved_in: ICON_BOOKING_MOVED_IN,
  booking_cancelled: ICON_BOOKING_CANCELLED,
  // Ответы клиента из бота (Волна 1, 01.09.2026). Иконки берём из того же набора,
  // по смыслу события: просьба перенести - та же стрелка переноса, просьба
  // отменить и предупреждение об опоздании - крестик и колокол соответственно.
  // Новых картинок не рисуем: чужеродная иконка в ленте видна сразу
  client_wants_move: ICON_BOOKING_MOVED_OUT,
  client_wants_cancel: ICON_BOOKING_CANCELLED,
  client_will_be_late: ICON_BELL,
};

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw Object.assign(new Error(path), { status: res.status, code: (await res.json().catch(() => null))?.error ?? null });
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(path), { status: res.status, code: (await res.json().catch(() => null))?.error ?? null });
  return res.json();
}

function timeAgo(iso) {
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч назад`;
  return `${Math.round(diffH / 24)} дн назад`;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Дата барбершопа - МСК круглый год (тот же приём, что в api/server.mjs): смещаем UTC
// на +3 и режем строку. new Date() без этого дал бы дату часового пояса браузера, и у
// сотрудника, открывшего CRM из другого пояса, «сегодня» уехало бы на день.
function shopTodayStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// «сегодня в 14:00» / «завтра в 14:00» / «22 августа в 14:00». Дата записи важнее
// времени создания уведомления: человек смотрит в ленту, чтобы понять, когда придёт
// клиент, а не когда сработал сервер.
export function formatBookingWhen(date, startTime) {
  if (!date) return '';
  const today = shopTodayStr();
  const time = startTime ? ` в ${startTime}` : '';
  if (date === today) return `сегодня${time}`;
  if (date === addDaysStr(today, 1)) return `завтра${time}`;
  if (date === addDaysStr(today, -1)) return `вчера${time}`;
  const [y, m, d] = date.split('-').map(Number);
  const month = MONTHS[m - 1] ?? '';
  const year = String(y) === today.slice(0, 4) ? '' : ` ${y}`;
  return `${d} ${month}${year}${time}`;
}

// Момент времени (создание записи) в том же языке, что и время визита выше: «сегодня в
// 14:32», «19 августа в 14:32». Часовой пояс - барбершопа, не браузера: сотрудник,
// открывший CRM из другого пояса, должен видеть время Ставрополя, иначе «создана в
// 11:32» разойдётся с тем, что помнит администратор.
export function formatMoment(iso) {
  if (!iso) return '';
  const msk = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  if (Number.isNaN(msk.getTime())) return '';
  return formatBookingWhen(msk.toISOString().slice(0, 10), msk.toISOString().slice(11, 16));
}

// Только цифры, приведённые к 7XXXXXXXXXX - в таком виде номер понимают и wa.me, и
// tg://resolve, и sms:/tel:. В базе он лежит как ввели ("+7 900 000-00-00",
// "89001234567"), сервер ищет клиента по последним 10 цифрам (normalizePhoneKey).
export function phoneDigits(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) digits = `7${digits}`;
  if (digits[0] === '8' && digits.length === 11) digits = `7${digits.slice(1)}`;
  return digits.length === 11 ? digits : '';
}

// Текст, который сотрудник отправляет клиенту. Собирается из фактов записи, ничего не
// выдумывает: нет имени мастера - строка про мастера просто не появится.
export function clientMessageText(booking) {
  if (!booking) return '';
  const name = booking.clientName ? `${booking.clientName}, ` : '';
  const when = formatBookingWhen(booking.date, booking.startTime);
  const master = booking.masterName ? `, ${T('master.nom')} ${booking.masterName}` : '';
  const services = booking.serviceNames ? ` (${booking.serviceNames})` : '';
  // Отменённой записи нельзя писать «ждём вас» - человек придёт к закрытому времени.
  // Кнопки связи на такой карточке нужны как раз чтобы предложить перенос, поэтому
  // текст сразу об этом
  if (booking.status === 'cancelled') {
    return `Здравствуйте, ${name}это ${tenantName()}. ${P('msg.cancelled', { when: `${when}${master}` })}. Напишите, если хотите перенести - подберём удобное время.`;
  }
  return `Здравствуйте, ${name}это ${tenantName()}. ${P('msg.expected', { when: `${when}${master}${services}` })}. Если планы изменятся - напишите, перенесём.`;
}

// Мессенджеры для связи с клиентом в один клик.
//
// MAX стоит особняком и работает НЕ как остальные три (правка Влада 21.08.2026 - «а
// МАКСа нет! добавь MAX и в уведомления тоже»). У MAX нет ссылки на чат по номеру -
// аналога wa.me не существует, это решение самого мессенджера ради приватности
// (проверено 21.08.2026 по справке help.max.ru и обзорам форматов ссылок, не по
// памяти). Личная ссылка max.ru/u/<хеш> есть только у того, кто сам ею поделился, а
// отправка боту по номеру требует корпоративной регистрации бота И согласия клиента,
// выданного этому боту заранее - это отдельная задача, не кнопка.
//
// Поэтому кнопка MAX делает ровно то, что человек делает руками, только без набора
// номера: открывает web.max.ru и кладёт номер в буфер обмена, чтобы вставить его в
// «Найти по номеру» (штатный поиск MAX по вкладке «Чаты»/«Контакты»). Честнее
// работающая кнопка на два шага, чем ссылка в никуда или отсутствие мессенджера,
// которым клиенты пользуются.
export function messengerLinks(phone, text) {
  const digits = phoneDigits(phone);
  if (!digits) return [];
  // Текста может не быть вовсе: в разделе «Клиенты» кнопки связи висят на человеке, а
  // не на конкретной записи, и когда ближайшей записи нет - сочинять за сотрудника
  // сообщение не из чего. Тогда открываем просто чат/набор номера, без подстановки:
  // пустой ?text= оставил бы в WhatsApp пустую строку ввода с висящим параметром.
  const encoded = encodeURIComponent(text ?? '');
  const withText = (base) => (encoded ? `${base}${base.includes('?') ? '&' : '?'}text=${encoded}` : base);
  return [
    { key: 'whatsapp', label: 'WhatsApp', href: withText(`https://wa.me/${digits}`) },
    // copyPhone - признак «ссылка сама в чат не приводит, номер нужен человеку в руки»
    { key: 'max', label: 'MAX', href: 'https://web.max.ru', copyPhone: digits },
    // tg://resolve открывает установленное приложение Telegram. Веб-ссылки на чат по
    // номеру у Telegram не существует - t.me/<номер> ведёт в пустоту, поэтому её здесь
    // нет: лучше кнопка, которая открывает приложение, чем кнопка в никуда.
    { key: 'telegram', label: 'Telegram', href: `tg://resolve?phone=${digits}` },
    { key: 'sms', label: 'СМС', href: encoded ? `sms:+${digits}?&body=${encoded}` : `sms:+${digits}` },
    { key: 'call', label: 'Позвонить', href: `tel:+${digits}` },
  ];
}

// Один ряд кнопок связи на оба места, где он есть: раздел «Уведомления» (карточка
// записи) и карточка клиента в разделе «Клиенты» (assets/crm-clients.js). Разметку не
// копируем во второй файл - разошлась бы при первой же правке.
export function messengerButtonsHtml(phone, text) {
  return messengerLinks(phone, text)
    .map((l) => {
      const copy = l.copyPhone ? ` data-copy-phone="${escapeHtml(l.copyPhone)}"` : '';
      const hint = l.copyPhone ? ' title="Откроет MAX и скопирует номер - вставьте его в «Найти по номеру»"' : '';
      return `<a class="btn btn-ghost btn-sm" href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer" data-msg-link="${l.key}"${copy}${hint}>${l.label}</a>`;
    })
    .join('');
}

// Клик по MAX: ссылка открывает мессенджер сама (обычный href), а мы кладём номер в
// буфер и говорим человеку, что с ним делать. Обработчик делегированный - карточки
// перерисовываются, вешать его на каждую кнопку заново было бы источником задвоений.
export function wireMessengerLinks(root) {
  if (!root || root.dataset.msgLinksWired === '1') return;
  root.dataset.msgLinksWired = '1';
  root.addEventListener('click', async (e) => {
    const link = e.target.closest('[data-copy-phone]');
    if (!link) return;
    const phone = link.dataset.copyPhone;
    try {
      // clipboard доступен только на https/localhost - на проде это выполняется, но
      // молча падать на локальном http-превью незачем, поэтому номер есть и в тексте
      // подсказки: скопировать его руками можно всегда
      await navigator.clipboard?.writeText(phone);
      showInfo(`Номер +${phone} скопирован - в MAX нажмите «Найти по номеру» и вставьте его`);
    } catch {
      showInfo(`В MAX нажмите «Найти по номеру» и введите +${phone}`);
    }
  });
}

// Провалиться из уведомления в саму запись. Календарь листается по дате, поэтому идём
// так: раздел «Расписание» → вид «День» на дату записи → карточка .appt[data-id] →
// её штатный обработчик (тот же, что срабатывает на клик мышью).
//
// Экспортирован 21.08.2026: тем же переходом пользуется история визитов в разделе
// «Клиенты» (assets/crm-clients.js) - «в каждой записи должна быть возможность
// провалиться в эту запись в расписании». Двух реализаций одного перехода не заводим:
// путь «раздел → день → карточка → её обработчик» один на всю CRM.
export async function openBookingFromNotification(booking) {
  if (!booking?.date) return false;
  goToSection('schedule'); // на страницах без оболочки (admin/master) безопасно ничего не делает
  // Вход в «Расписание» сам поднимает карточку «День» и грузит СЕГОДНЯШНИЙ день
  // (raiseDayOnEnter, assets/crm-schedule-views.js). Наш переход на дату записи стартует
  // одновременно с ним, и когда запись не на сегодня, ответ «сегодня» может прийти
  // последним и затереть нужный день - карточки на экране не окажется. Гонка видна по
  // коду (raiseDayOnEnter не знает про наш переход) и зависит от того, чей ответ придёт
  // вторым, поэтому не один вызов, а несколько попыток с проверкой результата: живёт
  // она ровно до первой отрисовки, дальше открытие дня стабильно.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await window.__openScheduleDay?.(booking.date);
    } catch {
      // день не загрузился - карточки не найдём, пробуем ещё раз, потом вернём false
    }
    const card = await waitForBookingCard(booking.id);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (window.openBookingEdit || window.openBooking)?.(card);
      return true;
    }
  }
  return false;
}

// Карточка появляется не в тот же тик, что ответ сервера: день перерисовывается целиком.
// Ждём её короткими интервалами, а не одним фиксированным таймаутом - на быстрой сети
// переход остаётся мгновенным.
async function waitForBookingCard(id, timeoutMs = 1200) {
  const selector = `.appt[data-id="${CSS.escape(String(id))}"]`;
  const deadline = Date.now() + timeoutMs;
  let card = document.querySelector(selector);
  while (!card && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    card = document.querySelector(selector);
  }
  return card;
}

function bookingSummaryHtml(booking, type) {
  const rows = [];
  const when = formatBookingWhen(booking.date, booking.startTime);
  const till = booking.endTime ? `–${booking.endTime}` : '';
  rows.push(`<div class="ntf-when">${escapeHtml(when)}${escapeHtml(till)}</div>`);
  const meta = [];
  if (booking.clientName) meta.push(booking.clientName);
  if (booking.masterName) meta.push(`${T('master.nom')} ${booking.masterName}`);
  if (booking.serviceNames) meta.push(booking.serviceNames);
  if (meta.length) rows.push(`<div class="ntf-meta">${escapeHtml(meta.join(' · '))}</div>`);
  // У уведомления об отмене это уже сказано заголовком - второй раз не повторяем.
  // На остальных типах строка нужна: «Новая запись», которую потом отменили руками в
  // расписании, иначе выглядела бы действующей
  if (booking.status === 'cancelled' && type !== 'booking_cancelled') {
    rows.push(`<div class="ntf-meta ntf-meta--off">${P('booking.cancelledShort')}</div>`);
  }
  return rows.join('');
}

// Полная карточка - раздел «Уведомления». Кнопки связи появляются только когда сервер
// реально отдал телефон: роли «мастер» он его не отдаёт (разд.12 п.1), и это не ошибка
// отрисовки, а правило доступа - выводим карточку без кнопок, не пустые заглушки.
// Когда запись завели - правка Влада 20.08.2026. Для новой записи момент уведомления и
// момент создания записи это одно и то же событие, поэтому показываем одну строку. Для
// переноса они расходятся: запись завели давно, а переехала она только что - показываем
// оба, иначе «5 мин назад» соврёт про возраст самой записи.
// Что именно случилось «5 минут назад» - зависит от типа. Раньше здесь для всего, кроме
// новой записи, стояло слово «перенесена», и отменённая запись подписывалась
// «перенесена только что» - прямое враньё в ленте (поймано глазами на скриншоте
// живого прогона 20.08.2026, ни один ассерт этого не заметил)
const EVENT_VERB = {
  booking_moved_in: 'перенесена',
  booking_moved_out: 'перенесена',
  booking_cancelled: 'отменена',
  // Ответы клиента: сама запись при этом никуда не делась, поэтому глагол про
  // просьбу, а не про запись - иначе лента врёт, как врала до 20.08.2026
  client_wants_move: 'просьба',
  client_wants_cancel: 'просьба',
  client_will_be_late: 'предупредил',
};

function timeLine(n) {
  const created = n.booking?.createdAt ? `${P('booking.created')} ${formatMoment(n.booking.createdAt)}` : '';
  const ago = timeAgo(n.createdAt);
  if (!created) return ago;
  // У новой записи момент уведомления и момент создания - одно событие, вторая строка
  // была бы повтором
  if (n.type === 'booking_new') return created;
  const verb = EVENT_VERB[n.type];
  return verb ? `${verb} ${ago} · ${created}` : `${ago} · ${created}`;
}

function fullItemHtml(n) {
  const b = n.booking;
  const actions = [];
  if (b) actions.push(`<button class="btn btn-ghost btn-sm" type="button" data-open-booking="${escapeHtml(b.id)}">${P('booking.open')}</button>`);
  if (b) actions.push(messengerButtonsHtml(b.clientPhone, clientMessageText(b)));
  // data-booking-id - адрес карточки по самой записи: по нему её находит живой прогон,
  // а сортировка ленты (свежее сверху) может поставить наверх любую другую
  return `<div class="ntf-card${n.read ? '' : ' ntf-card--unread'}" data-ntf-id="${escapeHtml(n.id)}" data-booking-id="${escapeHtml(b?.id ?? '')}">
      <span class="ntf-ico" aria-hidden="true">${TYPE_ICON[n.type] ?? ICON_BELL}</span>
      <div class="ntf-body">
        <div class="ntf-title">${escapeHtml(n.title)}</div>
        ${b ? bookingSummaryHtml(b, n.type) : `<div class="ntf-meta">${escapeHtml(n.body ?? '')}</div>`}
        <div class="ntf-time">${escapeHtml(timeLine(n))}</div>
        ${actions.length ? `<div class="ntf-actions">${actions.join('')}</div>` : ''}
      </div>
    </div>`;
}

// Сжатая строка - колокольчик. Ровно то же событие, но без кнопок и услуг: сюда
// заглядывают между клиентами, чтобы понять «что-то новое есть?».
function compactItemHtml(n) {
  const b = n.booking;
  const sub = b ? `${formatBookingWhen(b.date, b.startTime)}${b.clientName ? ' · ' + b.clientName : ''}` : (n.body ?? '');
  return `<div class="msg-item${n.read ? '' : ' msg-item--unread'}" data-ntf-id="${escapeHtml(n.id)}" data-booking-id="${escapeHtml(b?.id ?? '')}">
      <span class="msg-ico">${TYPE_ICON[n.type] ?? ICON_BELL}</span>
      <div class="msg-body">
        <div class="msg-title">${escapeHtml(n.title)}</div>
        ${sub ? `<div class="msg-sub">${escapeHtml(sub)}</div>` : ''}
        <div class="msg-time">${escapeHtml(timeAgo(n.createdAt))}</div>
      </div>
      <button class="msg-dismiss" type="button" data-dismiss="${escapeHtml(n.id)}" aria-label="Убрать из колокольчика" title="Убрать из колокольчика - в разделе «Уведомления» останется">${ICON_CLOSE}</button>
    </div>`;
}

export function wireNotifications(staff) {
  const bell = document.getElementById('msgBell');
  const badge = document.getElementById('msgBellBadge');
  const panel = document.getElementById('msgPanel');
  const list = document.getElementById('msgList');
  const center = document.getElementById('notifCenter'); // раздел «Уведомления», только у владельца
  if (!bell || !badge || !panel || !list) return; // страница без этого блока - no-op

  const iconEl = document.getElementById('msgBellIcon');
  if (iconEl) iconEl.innerHTML = ICON_BELL;

  // Списки у колокольчика и раздела теперь РАЗНЫЕ (правка Влада 20.08.2026):
  // колокольчик показывает только неубранные (?scope=bell), раздел - весь журнал,
  // включая убранные. Держим оба последних ответа, чтобы обработчики кликов не ходили
  // за ними снова.
  let bellCache = [];
  let centerCache = [];

  async function loadBell() {
    bellCache = await apiGet('/notifications?scope=bell');
    return bellCache;
  }

  async function loadCenter() {
    centerCache = await apiGet('/notifications');
    return centerCache;
  }

  async function refreshBadge() {
    try {
      // Клиенты «которым стоит позвонить» больше не входят в счётчик (20.08.2026):
      // их число прибавлялось к бейджу, но в самом списке их не было никогда - цифра
      // обещала письма, которых человек не находил. Список живёт в разделе «Клиенты».
      const { count } = await apiGet('/notifications/unread-count');
      // Трёхзначное число на колокольчике читается как захламление, а не как сигнал:
      // 150 писем всё равно никто не разбирает по одному (04.09.2026, осмотр кабинета).
      // Выше сотни показываем «99+» - точное число ничего не добавляет к решению
      // «зайти в раздел», а место в бейдже конечное
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.title = count > 99 ? `${count} непрочитанных` : '';
      badge.hidden = count === 0;
    } catch {
      // тихо - основной индикатор живой базы уже есть в liveProof выше на странице
    }
  }

  function markReadOnClick(item, id) {
    if (!item.classList.contains('msg-item--unread') && !item.classList.contains('ntf-card--unread')) return Promise.resolve();
    item.classList.remove('msg-item--unread', 'ntf-card--unread');
    return apiPost(`/notifications/${id}/read`)
      .then(refreshBadge)
      .catch(() => {
        /* бейдж просто не обновится досрочно, следующий поллинг поправит */
      });
  }

  async function renderCompact() {
    list.innerHTML = `<div style="padding:10px">${skeletonMarkup(3)}</div>`;
    try {
      const items = await loadBell();
      if (!items.length) {
        list.innerHTML = emptyBellHtml();
        return;
      }
      const shown = items.slice(0, COMPACT_LIMIT);
      const more = center && items.length > shown.length
        ? `<button class="msg-more" type="button" data-open-center>Показать все (${items.length})</button>`
        : '';
      list.innerHTML = shown.map(compactItemHtml).join('') + more;

      list.querySelectorAll('.msg-item').forEach((item) => {
        item.addEventListener('click', async () => {
          const id = item.dataset.ntfId;
          await markReadOnClick(item, id);
          const bookingId = item.dataset.bookingId;
          const n = bellCache.find((x) => x.id === id);
          panel.classList.remove('open');
          // Клик по строке в колокольчике ведёт туда же, куда кнопка в разделе - в саму
          // запись. Не вышло (запись отменена, день не открылся) - открываем раздел,
          // чтобы человек хотя бы видел карточку целиком, а не молчаливое «ничего».
          const opened = bookingId ? await openBookingFromNotification(n?.booking) : false;
          if (!opened && center) goToSection('notifications');
        });
      });
      // Убрать из колокольчика. Строка уходит из шапки сразу, не дожидаясь ответа
      // сервера - человек нажал крестик и ждёт, что она исчезнет; если запрос упадёт,
      // следующий тик счётчика вернёт её на место сам.
      list.querySelectorAll('[data-dismiss]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation(); // клик по крестику не должен открывать запись
          const id = btn.dataset.dismiss;
          const item = btn.closest('.msg-item');
          item?.remove();
          bellCache = bellCache.filter((x) => x.id !== id);
          if (!list.querySelector('.msg-item')) list.innerHTML = emptyBellHtml();
          try {
            await apiPost(`/notifications/${id}/dismiss`);
            refreshBadge();
            // Раздел показывает ту же строку, но уже как прочитанную - перерисуем,
            // если он открыт, чтобы два места не расходились на глазах
            renderCenter();
          } catch (err) {
            showError(errorMessage(err, 'Не удалось убрать уведомление'));
            renderCompact();
          }
        });
      });

      list.querySelector('[data-open-center]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.remove('open');
        goToSection('notifications');
      });
    } catch (err) {
      list.innerHTML = '<div class="note" style="padding:10px"></div>';
      list.querySelector('.note').textContent = errorMessage(err, 'Не удалось загрузить уведомления');
      showError(errorMessage(err, 'Не удалось загрузить уведомления'));
    }
  }

  async function renderCenter() {
    if (!center) return;
    center.innerHTML = skeletonMarkup(3);
    try {
      const items = await loadCenter();
      if (!items.length) {
        center.innerHTML = `<p class="note">${P('booking.emptyFeed')}</p>`;
        return;
      }
      center.innerHTML = items.map(fullItemHtml).join('');
      wireMessengerLinks(center); // кнопка MAX копирует номер (см. messengerLinks выше)

      center.querySelectorAll('.ntf-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('[data-open-booking]') || e.target.closest('[data-msg-link]')) return;
          markReadOnClick(card, card.dataset.ntfId);
        });
      });
      center.querySelectorAll('[data-open-booking]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const card = btn.closest('.ntf-card');
          const n = centerCache.find((x) => x.id === card?.dataset.ntfId);
          showSpinner(btn.closest('.ntf-actions'), P('booking.opening'));
          await markReadOnClick(card, card?.dataset.ntfId);
          const opened = await openBookingFromNotification(n?.booking);
          if (!opened) showError(P('booking.notInSchedule'));
          renderCenter();
        });
      });
      // Ссылки в мессенджер уводят со страницы - уведомление честно считаем
      // прочитанным в тот же момент, иначе оно остаётся непрочитанным навсегда у
      // человека, который уже написал клиенту.
      center.querySelectorAll('[data-msg-link]').forEach((link) => {
        link.addEventListener('click', () => {
          const card = link.closest('.ntf-card');
          markReadOnClick(card, card?.dataset.ntfId);
        });
      });
    } catch (err) {
      center.innerHTML = '<p class="note"></p>';
      center.querySelector('.note').textContent = errorMessage(err, 'Не удалось загрузить уведомления');
      showError(errorMessage(err, 'Не удалось загрузить уведомления'));
    }
  }

  bell.addEventListener('click', () => {
    const opening = !panel.classList.contains('open');
    document.querySelectorAll('.msg-panel.open').forEach((p) => p.classList.remove('open'));
    if (opening) {
      panel.classList.add('open');
      renderCompact();
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && !bell.contains(e.target)) panel.classList.remove('open');
  });

  refreshBadge();
  renderCenter();
  // Мягкое обновление (кнопка «Обновить данные», Окно 45) и живой поток событий
  // (assets/crm-live.js) дёргают этот хук - он перечитывает и счётчик, и раздел.
  window.__refreshNotifications = () => Promise.all([refreshBadge(), renderCenter()]);
  setInterval(refreshBadge, 45 * 1000);
}
