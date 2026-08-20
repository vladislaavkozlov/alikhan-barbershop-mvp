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
import { ICON_BELL, ICON_BOOKING_NEW, ICON_BOOKING_MOVED_IN, ICON_BOOKING_MOVED_OUT } from './crm-icons.js';
// Экранирование берём готовое из crm-schedule-shared.js - та же функция уже защищает
// пять других CRM-файлов, своей копии не заводим. Нужна она здесь по-прежнему: имя
// клиента приезжает из АНОНИМНОГО POST /bookings с публичного сайта (XSS, найденный
// живым прогоном 10.08.2026: clientName = '<img src=x onerror=alert(1)>' доходил до
// списка уведомлений мастера дословно).
import { escapeHtml } from './crm-schedule-shared.js';
import { errorMessage, showError } from './crm-toast.js';
import { showSpinner, skeletonMarkup } from './crm-loading.js';

const TOKEN_KEY = 'alikhan-crm:token';
const API = window.ALIKHAN_API_URL;
const COMPACT_LIMIT = 6; // сколько строк показывает колокольчик, прежде чем отправить в раздел

// Иконки - штриховые SVG того же набора, что сайдбар и шапка (assets/crm-icons.js),
// не эмодзи: в крупной карточке раздела эмодзи выпадал из общего стиля. Стрелка
// направления сохранена - в списке из десяти строк видно, ушла запись или пришла.
const TYPE_ICON = {
  booking_new: ICON_BOOKING_NEW,
  booking_moved_out: ICON_BOOKING_MOVED_OUT,
  booking_moved_in: ICON_BOOKING_MOVED_IN,
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
  const master = booking.masterName ? `, мастер ${booking.masterName}` : '';
  const services = booking.serviceNames ? ` (${booking.serviceNames})` : '';
  return `Здравствуйте, ${name}это барбершоп «Алихан». Ждём вас ${when}${master}${services}. Если планы изменятся - напишите, перенесём.`;
}

// Мессенджеры, в которые реально можно попасть ссылкой по номеру телефона.
//
// МАКС здесь намеренно нет: у него нет ссылки на личный чат по номеру (аналога wa.me),
// это ограничение самого мессенджера - личная ссылка вида max.ru/u/<хеш> есть только у
// того, кто сам ею поделился. Автоматическая отправка клиенту в МАКС - отдельная
// задача, она делается ботом и требует, чтобы клиент сам подписался на него.
export function messengerLinks(phone, text) {
  const digits = phoneDigits(phone);
  if (!digits) return [];
  const encoded = encodeURIComponent(text);
  return [
    { key: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/${digits}?text=${encoded}` },
    // tg://resolve открывает установленное приложение Telegram. Веб-ссылки на чат по
    // номеру у Telegram не существует - t.me/<номер> ведёт в пустоту, поэтому её здесь
    // нет: лучше кнопка, которая открывает приложение, чем кнопка в никуда.
    { key: 'telegram', label: 'Telegram', href: `tg://resolve?phone=${digits}` },
    { key: 'sms', label: 'СМС', href: `sms:+${digits}?&body=${encoded}` },
    { key: 'call', label: 'Позвонить', href: `tel:+${digits}` },
  ];
}

// Провалиться из уведомления в саму запись. Календарь листается по дате, поэтому идём
// так: раздел «Расписание» → вид «День» на дату записи → карточка .appt[data-id] →
// её штатный обработчик (тот же, что срабатывает на клик мышью).
async function openBookingFromNotification(booking) {
  if (!booking?.date) return false;
  goToSection('schedule'); // на страницах без оболочки (admin/master) безопасно ничего не делает
  try {
    await window.__openScheduleDay?.(booking.date);
  } catch {
    // день не загрузился - ниже карточки не найдём и честно вернём false
  }
  const card = document.querySelector(`.appt[data-id="${CSS.escape(booking.id)}"]`);
  if (!card) return false;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  (window.openBookingEdit || window.openBooking)?.(card);
  return true;
}

function bookingSummaryHtml(booking) {
  const rows = [];
  const when = formatBookingWhen(booking.date, booking.startTime);
  const till = booking.endTime ? `–${booking.endTime}` : '';
  rows.push(`<div class="ntf-when">${escapeHtml(when)}${escapeHtml(till)}</div>`);
  const meta = [];
  if (booking.clientName) meta.push(booking.clientName);
  if (booking.masterName) meta.push(`мастер ${booking.masterName}`);
  if (booking.serviceNames) meta.push(booking.serviceNames);
  if (meta.length) rows.push(`<div class="ntf-meta">${escapeHtml(meta.join(' · '))}</div>`);
  if (booking.status === 'cancelled') rows.push('<div class="ntf-meta ntf-meta--off">Запись отменена</div>');
  return rows.join('');
}

// Полная карточка - раздел «Уведомления». Кнопки связи появляются только когда сервер
// реально отдал телефон: роли «мастер» он его не отдаёт (разд.12 п.1), и это не ошибка
// отрисовки, а правило доступа - выводим карточку без кнопок, не пустые заглушки.
function fullItemHtml(n) {
  const b = n.booking;
  const links = b ? messengerLinks(b.clientPhone, clientMessageText(b)) : [];
  const actions = [];
  if (b) actions.push(`<button class="btn btn-ghost btn-sm" type="button" data-open-booking="${escapeHtml(b.id)}">Открыть запись</button>`);
  links.forEach((l) => {
    actions.push(`<a class="btn btn-ghost btn-sm" href="${escapeHtml(l.href)}" target="_blank" rel="noopener noreferrer" data-msg-link="${l.key}">${l.label}</a>`);
  });
  // data-booking-id - адрес карточки по самой записи: по нему её находит живой прогон,
  // а сортировка ленты (свежее сверху) может поставить наверх любую другую
  return `<div class="ntf-card${n.read ? '' : ' ntf-card--unread'}" data-ntf-id="${escapeHtml(n.id)}" data-booking-id="${escapeHtml(b?.id ?? '')}">
      <span class="ntf-ico" aria-hidden="true">${TYPE_ICON[n.type] ?? ICON_BELL}</span>
      <div class="ntf-body">
        <div class="ntf-title">${escapeHtml(n.title)}</div>
        ${b ? bookingSummaryHtml(b) : `<div class="ntf-meta">${escapeHtml(n.body ?? '')}</div>`}
        <div class="ntf-time">${escapeHtml(timeAgo(n.createdAt))}</div>
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

  // Один запрос кормит оба вида - и колокольчик, и раздел. Держим последний ответ,
  // чтобы обработчики кликов не ходили за ним снова.
  let cache = [];

  async function load() {
    cache = await apiGet('/notifications');
    return cache;
  }

  async function refreshBadge() {
    try {
      // Клиенты «которым стоит позвонить» больше не входят в счётчик (20.08.2026):
      // их число прибавлялось к бейджу, но в самом списке их не было никогда - цифра
      // обещала письма, которых человек не находил. Список живёт в разделе «Клиенты».
      const { count } = await apiGet('/notifications/unread-count');
      badge.textContent = count;
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
      const items = await load();
      if (!items.length) {
        list.innerHTML = '<div class="note" style="padding:10px">Новых записей нет</div>';
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
          const n = cache.find((x) => x.id === id);
          panel.classList.remove('open');
          // Клик по строке в колокольчике ведёт туда же, куда кнопка в разделе - в саму
          // запись. Не вышло (запись отменена, день не открылся) - открываем раздел,
          // чтобы человек хотя бы видел карточку целиком, а не молчаливое «ничего».
          const opened = bookingId ? await openBookingFromNotification(n?.booking) : false;
          if (!opened && center) goToSection('notifications');
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
      const items = await load();
      if (!items.length) {
        center.innerHTML = '<p class="note">Пока ни одной новой записи. Здесь появится каждая запись клиента - сразу, как её создадут на сайте или в CRM</p>';
        return;
      }
      center.innerHTML = items.map(fullItemHtml).join('');

      center.querySelectorAll('.ntf-card').forEach((card) => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('[data-open-booking]') || e.target.closest('[data-msg-link]')) return;
          markReadOnClick(card, card.dataset.ntfId);
        });
      });
      center.querySelectorAll('[data-open-booking]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const card = btn.closest('.ntf-card');
          const n = cache.find((x) => x.id === card?.dataset.ntfId);
          showSpinner(btn.closest('.ntf-actions'), 'Открываю запись');
          await markReadOnClick(card, card?.dataset.ntfId);
          const opened = await openBookingFromNotification(n?.booking);
          if (!opened) showError('Запись не найдена в расписании - возможно, её отменили');
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
