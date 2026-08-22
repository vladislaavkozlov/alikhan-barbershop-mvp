// Окно 39 (06.08.2026, Задача 2 - только crm-owner.html в первой итерации). Список
// "требует внимания" (GET /clients?risk=true) заменяет статичный декоративный пример
// "3 клиента не приходили 3+ месяца" (Клиент Ж/З/И, PRODUCT_AUDIT_REPORT.md,
// "Бизнес-проблемы"), карточка клиента (GET /clients/:id) - историю визитов и
// индикатор риска. Честная оговорка промпта: requiresPrepayment ничего не блокирует
// технически - весь текст риска приходит с сервера (risk.label, server.mjs
// describeClientRisk) уже в форме "стоит позвонить", фронт его не сочиняет и не
// подаёт как "клиент заблокирован".
//
// Окно 42 (07.08.2026, ПРОМПТ-ОКНО-42-ДЕМОНТАЖ-СЕГОДНЯ.md): у списка больше нет
// экрана на crm-owner.html (раздел "Клиенты" - Окно 48, пока заглушка) - решение
// Влада не городить временный дом ради одного списка. Ни #raList, ни счётчика
// #riskClientsBadge на странице сейчас нет (правка 07.08.2026 - колокольчик риск-
// клиентов объединён с колокольчиком уведомлений, assets/crm-notifications.js
// считает риск-клиентов отдельным fetch'ем для общего бейджа) - renderRiskList()
// ниже сразу выходит по guard'у и ничего не делает на этой странице, сам модуль не
// удалён и вернётся к полноценному рендеру, когда появится раздел "Клиенты".
import { fetchJson, apiSend } from './crm-auth.js';
import { errorMessage, showError, showSuccess } from './crm-toast.js';
import { showSkeleton, showSpinner, setButtonBusy } from './crm-loading.js';
// Подписи каналов («Яндекс Карты», «2ГИС», …) для строки «откуда пришёл» в разделе
// «Клиенты» - один словарь на весь проект, см. assets/client-source.js
import { CLIENT_SOURCE_LABELS } from './client-source.js';
// Кнопка «Развернуть все» над списком карточек - общий механизм разделов владельца
// (assets/crm-navigation-panels.js). Зовём его ПОСЛЕ отрисовки списка: на загрузке
// страницы он уже отработал, а карточек клиентов тогда ещё не было ни одной, и
// кнопка просто не создавалась (нашёл Влад на проде 21.08.2026)
import { initCrmNavigationPanels } from './crm-navigation-panels.js';
// Связь с клиентом и переход в запись - тот же механизм, что в разделе «Уведомления»
// (assets/crm-notifications.js): один набор кнопок WhatsApp/Telegram/СМС/Позвонить и
// один путь «раздел Расписание → День на дату записи → карточка → её обработчик».
// Задача Влада 21.08.2026: из истории клиента проваливаться в саму запись, а кнопки
// связи держать рядом с «Записать снова», как в уведомлениях.
import { messengerButtonsHtml, clientMessageText, openBookingFromNotification, wireMessengerLinks } from './crm-notifications.js';
// Срок обновления стрижки (Окно 59, 22.08.2026) - словарь подписей один на весь
// проект, тот же, что в форме закрытия визита
import { RENEW_REASON_LABELS, RENEW_REASON_SHORT } from './renew-reason.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function el(id) {
  return document.getElementById(id);
}

function formatVisitDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

// Названия статусов - те же, что в карточке записи (13.08.2026: "Пришёл" стал
// "Обслужен" - done значит завершённую сделку, а не просто явку), только строчными:
// здесь они идут внутри строки визита, не отдельным контролом.
const STATUS_LABEL = { planned: 'ожидается', done: 'обслужен', cancelled: 'отменена', no_show: 'не пришёл' };

// Окно 45 (08.08.2026) - экспортирован для кнопки мягкого обновления (вызывать
// именно эту функцию, не wireClientsRisk() заново - та навесила бы обработчик
// на #clientCardClose второй раз).
export async function renderRiskList() {
  const list = el('raList');
  const badge = el('riskClientsBadge');
  // Ни списка (страница без раздела "Клиенты"), ни бейджа (страница без этого
  // колокольчика вообще) - нечего обновлять, тихо выходим (тот же no-op паттерн,
  // что и у wireNotifications, assets/crm-notifications.js).
  if (!list && !badge) return;
  try {
    const clients = await fetchJson('/clients?risk=true');
    if (badge) badge.textContent = String(clients.length);
    if (list) {
      if (clients.length === 0) {
        list.innerHTML = '<p class="payroll-note">Нет клиентов, которым сейчас стоит позвонить</p>';
      } else {
        list.innerHTML = clients
          .map(
            (c) => `<div class="ra-row">
              <span class="ra-name">${escapeHtml(c.name || 'Без имени')}</span>
              <span class="ra-last">${escapeHtml(c.risk.label || '')}</span>
              ${c.phone ? `<a class="btn btn-ghost btn-sm" href="tel:${escapeHtml(c.phone)}">Позвонить</a>` : ''}
              <button class="btn btn-ghost btn-sm" type="button" data-open-client-id="${escapeHtml(c.id)}">Открыть карточку</button>
              <button class="ra-dismiss" type="button" title="Скрыть из списка на эту сессию" onclick="dismissRetentionRow(this)">✕</button>
            </div>`
          )
          .join('');
        list.querySelectorAll('[data-open-client-id]').forEach((btn) => {
          btn.addEventListener('click', () => openClientCard(btn.dataset.openClientId));
        });
      }
    }
  } catch (err) {
    if (list) list.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(err, 'Не удалось загрузить список клиентов'))}</p>`;
    showError(errorMessage(err, 'Не удалось загрузить список клиентов'));
  }
}

export function wireClientsRisk() {
  const closeBtn = el('clientCardClose');
  if (closeBtn && !closeBtn.dataset.wired) {
    closeBtn.dataset.wired = '1';
    closeBtn.addEventListener('click', () => {
      el('clientCardModal').hidden = true;
    });
  }

  // #crmMain остаётся hidden (initCrmAuth, assets/crm-auth.js) до успешного входа -
  // токена ещё нет, ранний fetchJson('/clients?risk=true') получил бы 401. Тот же
  // приём, что уже применён в assets/crm-schedule-requests.js (initOwnerScheduleRequests):
  // своего хука "пользователь вошёл" crm-auth.js не отдаёт, поэтому ждём снятия
  // hidden наблюдателем. Восстановленная сессия снимает hidden синхронно раньше
  // этой точки - startOnce() проверяет и текущее состояние.
  const main = el('crmMain');
  if (!main) return;
  let started = false;
  function startOnce() {
    if (started || main.hidden) return;
    started = true;
    renderRiskList();
  }
  new MutationObserver(startOnce).observe(main, { attributes: true, attributeFilter: ['hidden'] });
  startOnce();
}

export async function openClientCard(clientId) {
  const modal = el('clientCardModal');
  const nameEl = el('clientCardName');
  const phoneEl = el('clientCardPhone');
  const riskEl = el('clientCardRisk');
  const rebookBtn = el('clientCardRebook');
  const visitsEl = el('clientCardVisits');
  if (!modal || !nameEl || !phoneEl || !riskEl || !rebookBtn || !visitsEl) return;

  modal.hidden = false;
  showSpinner(nameEl, 'Загружаю карточку клиента');
  phoneEl.textContent = '';
  riskEl.hidden = true;
  rebookBtn.hidden = true;
  showSkeleton(visitsEl, 3);

  try {
    const card = await fetchJson(`/clients/${encodeURIComponent(clientId)}`);
    nameEl.textContent = card.name || 'Без имени';
    phoneEl.textContent = card.phone || '';
    if (card.risk?.label) {
      riskEl.hidden = false;
      riskEl.textContent = card.risk.label;
    }
    if (card.visits.length === 0) {
      visitsEl.innerHTML = '<span class="note">Визитов пока не было</span>';
    } else {
      visitsEl.innerHTML = card.visits
        .map((v) => {
          const services = v.services.map((s) => escapeHtml(s.name)).join(', ') || '—';
          // Комментарий сотрудника к визиту (13.08.2026, миграция 048) - "почему сумма
          // отличалась от прайса". Именно история клиента - место, где это читают
          // спустя месяцы, поэтому строка идёт прямо под визитом. Мастеру поле не
          // приходит вовсе (shapeClientCardForViewer), у него строки просто не будет.
          const comment = v.staffComment
            ? `<span class="visit-comment">💬 ${escapeHtml(v.staffComment)}</span>`
            : '';
          return `<div class="break-row"><span>${formatVisitDate(v.date)} ${escapeHtml(v.startTime)}</span><span class="note">${services} · ${escapeHtml(v.masterName || '')} · ${STATUS_LABEL[v.status] || escapeHtml(v.status)}${comment}</span></div>`;
        })
        .join('');
    }
    // "Записать снова" - только если есть история (мастера/услуги брать неоткуда) и
    // страница умеет открыть форму записи в режиме будущей брони (window.openRebookBooking,
    // выставляет assets/crm-auth.js wireWalkIn только когда на странице есть
    // wfModeLabel/wfDateTimeRow - пока только crm-owner.html, это Задача 2 промпта).
    if (card.lastVisit && typeof window.openRebookBooking === 'function') {
      rebookBtn.hidden = false;
      rebookBtn.onclick = () => {
        modal.hidden = true;
        window.openRebookBooking(
          card.lastVisit.masterId,
          card.lastVisit.masterName || '',
          card.name,
          card.phone,
          card.lastVisit.services.map((s) => s.id)
        );
      };
    }
  } catch (err) {
    nameEl.textContent = 'Карточка не открылась';
    visitsEl.innerHTML = `<span class="note">${escapeHtml(errorMessage(err, 'Не удалось загрузить карточку клиента'))}</span>`;
    showError(errorMessage(err, 'Не удалось загрузить карточку клиента'));
  }
}

// ── Раздел «Клиенты» (21.08.2026, задача Влада: «база данных клиентов - имена,
// телефоны, комментарии, откуда и когда пришли, история записей, сколько денег
// принесли»). Список кормится GET /clients?all=true (владелец/управляющий), история
// конкретного клиента - тем же GET /clients/:id, что уже открывает карточку из
// списка «стоит позвонить»: два экрана не должны знать форму карточки по-своему.
//
// История грузится в момент РАСКРЫТИЯ карточки, а не всем списком сразу: в списке
// сотни клиентов, у каждого своя история визитов и услуг, и тянуть всё это ради
// свёрнутых строк значило бы ждать раздел секундами вместо мгновенного открытия.

// Что пришло с сервера в последний раз. Поиск фильтрует ЭТОТ массив на месте, не
// дёргая сервер на каждую букву: база клиентов барбершопа - это тысячи строк максимум,
// они уже в браузере, а запрос на каждое нажатие клавиши дал бы мигающий список.
let clientsCache = [];

function formatMoney(sum) {
  return `${Number(sum || 0).toLocaleString('ru-RU')} ₽`;
}

function pluralVisits(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'визитов';
  if (mod10 === 1) return 'визит';
  if (mod10 >= 2 && mod10 <= 4) return 'визита';
  return 'визитов';
}

// Только цифры - телефон в базе лежит сырой строкой (см. normalizePhoneKey,
// api/routes/clients.js), и человек ищет «9188» не думая про скобки и пробелы.
function digitsOf(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function filterClients(clients, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return clients;
  const digits = digitsOf(q);
  return clients.filter((c) => {
    const byName = (c.name || '').toLowerCase().includes(q);
    const byPhone = digits.length > 0 && digitsOf(c.phone).includes(digits);
    return byName || byPhone;
  });
}

// Строка фактов под именем - набор отдельных «плашек», а не перечисление через
// пробел (правка Влада 21.08.2026: «сделай симпатичнее сами шапки»). Слитный текст
// «0 визитов принёс 0 ₽ с 19.08.2026 Пропустил последнюю запись» читался как одно
// длинное предложение, в котором глазу не за что зацепиться.
function chip(inner, modifier = '') {
  return `<span class="client-chip${modifier}">${inner}</span>`;
}

function clientFacts(c) {
  const facts = [];
  // Новый клиент - одна честная плашка вместо двух нулей подряд: «0 визитов, принёс
  // 0 ₽» технически верно, но выглядит как упрёк человеку, который просто записался
  // впервые и ещё не пришёл
  if (c.visitsCount === 0) {
    facts.push(chip('Пока без визитов'));
  } else {
    facts.push(chip(`<b>${c.visitsCount}</b> ${pluralVisits(c.visitsCount)}`));
    facts.push(chip(`принёс <b>${formatMoney(c.revenue)}</b>`, ' client-chip--money'));
  }
  if (c.firstVisitDate) {
    facts.push(chip(`с нами с ${formatVisitDate(c.firstVisitDate)}`));
    // «Откуда» показываем только когда канал реально записан на первой брони.
    // Клиент, записанный до появления этого поля (миграция 050, 17.08.2026), источника
    // не имеет - и строка «Другое» тут была бы выдумкой, а не фактом.
    const source = CLIENT_SOURCE_LABELS[c.source];
    if (source) facts.push(chip(escapeHtml(source), ' client-chip--source'));
  }
  if (c.risk?.label) facts.push(chip(escapeHtml(c.risk.label), ' client-chip--risk'));
  return facts.join('');
}

const ICON_CLIENT_AVATAR =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="7" r="3"/><path d="M4 16.5c0-3.1 2.7-5 6-5s6 1.9 6 5"/></svg>';

function clientCardMarkup(c) {
  const phone = c.phone ? `<div class="role">${escapeHtml(c.phone)}</div>` : '';
  return `<details class="staff-card client-card" data-client-id="${escapeHtml(c.id)}">
    <summary>
      <div class="avatar-icon" aria-hidden="true">${ICON_CLIENT_AVATAR}</div>
      <div class="summary-meta">
        <div class="name">${escapeHtml(c.name || 'Без имени')}</div>
        ${phone}
        <div class="client-facts">${clientFacts(c)}</div>
      </div>
      <span class="chevron">▸</span>
    </summary>
    <div class="staff-card-body" data-client-body><p class="payroll-note">Раскройте карточку, чтобы увидеть историю</p></div>
  </details>`;
}

// Комментарий может быть на все 3000 знаков (лимит заказчика), а в истории клиента
// таких визитов десяток. Длинный текст показываем свёрнутым: иначе одна заметка
// выталкивает всю остальную историю за экран, и раздел перестаёт отвечать на главный
// вопрос «когда человек приходил». Короткие (в один-два взгляда) не прячем вовсе -
// клик ради двух строк был бы лишним движением.
const COMMENT_PREVIEW_LEN = 220;

function commentMarkup(text) {
  if (!text) return '';
  if (text.length <= COMMENT_PREVIEW_LEN) {
    return `<span class="client-visit-comment" data-comment-full>${escapeHtml(text)}</span>`;
  }
  // Режем по границе слова, а не посреди него - обрывок «постоянный кли» читается
  // как сбой интерфейса, а не как сокращение
  const cut = text.slice(0, COMMENT_PREVIEW_LEN);
  const preview = cut.slice(0, Math.max(cut.lastIndexOf(' '), COMMENT_PREVIEW_LEN - 30));
  return `<details class="client-visit-comment client-visit-comment--long">
    <summary><span class="client-comment-preview">${escapeHtml(preview)}…</span><span class="client-comment-more">Показать целиком</span></summary>
    <span data-comment-full>${escapeHtml(text)}</span>
  </details>`;
}

// Цвет статуса в истории - тот же язык, что в календаре «Дня» (assets/crm-calendar.js,
// .appt--status-*): зелёный - обслужен, красный - не пришёл, золото - ожидается,
// серый - отменена. Свою палитру не заводим: человек уже выучил эти цвета на
// расписании, и второй словарь цветов означал бы, что их надо учить заново
const STATUS_MOD = { planned: 'planned', done: 'done', cancelled: 'cancelled', no_show: 'noshow' };

// Отменённой записи в расписании нет как карточки (buildCancelledCard,
// assets/crm-calendar.js рисует её приглушённой и некликабельной, без data-id) -
// значит и провалиться в неё некуда. Такую строку истории оставляем обычным текстом
// с честной подсказкой, а не кнопкой, которая не сработает.
function isOpenableVisit(v) {
  return Boolean(v?.id && v?.date && v.status !== 'cancelled');
}

function visitMarkup(v) {
  const services = v.services.map((s) => escapeHtml(s.name)).join(', ') || '—';
  const statusMod = STATUS_MOD[v.status] ?? 'planned';
  const status = `<span class="client-visit-status client-visit-status--${statusMod}">${STATUS_LABEL[v.status] || escapeHtml(v.status)}</span>`;
  // Сумма - только у состоявшихся визитов: «ожидается» и «отменена» деньгами ещё
  // (или уже) не являются, и цифра рядом с ними читалась бы как выручка, которой нет.
  const sum = v.status === 'done' && v.price != null ? `<span class="client-visit-sum">${formatMoney(v.price)}</span>` : '';
  const comment = commentMarkup(v.staffComment);
  // Вся строка визита - одна кнопка перехода в расписание. Не отдельная иконка
  // «открыть»: в истории десяток строк, и ряд иконок справа читался бы как ещё один
  // столбец данных. Роль/tabindex/aria - чтобы с клавиатуры работало так же, как мышью.
  const openable = isOpenableVisit(v);
  const openAttrs = openable
    ? ` role="button" tabindex="0" data-visit-id="${escapeHtml(v.id)}" data-visit-date="${escapeHtml(v.date)}" title="Открыть эту запись в расписании" aria-label="Открыть запись ${escapeHtml(formatVisitDate(v.date))} ${escapeHtml(v.startTime)} в расписании"`
    : ' title="Отменённой записи в расписании нет"';
  const openClass = openable ? ' client-visit--openable' : '';

  return `<div class="client-visit client-visit--${statusMod}${openClass}"${openAttrs}>
    <div class="client-visit-head">
      <span class="client-visit-date">${formatVisitDate(v.date)} ${escapeHtml(v.startTime)}</span>
      ${status}
      <span class="client-visit-meta">${services} · ${escapeHtml(v.masterName || '')}</span>
      ${sum}
    </div>
    ${comment}
  </div>`;
}

// Ближайшая ПРЕДСТОЯЩАЯ запись клиента. visits приходят отсортированными по дате вниз
// (getClientCard, api/routes/clients.js), поэтому ближайшая к сегодня - последняя из
// запланированных. Прошедшие «ожидается» (статус не проставили) в текст напоминания не
// берём: писать «ждём вас» про позавчера нельзя.
function nextPlannedVisit(visits) {
  const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10); // сутки барбершопа, МСК
  const planned = (visits ?? []).filter((v) => v.status === 'planned' && v.date >= today);
  return planned.length ? planned[planned.length - 1] : null;
}

// Клик по строке визита - переход в саму запись. Делегируем на теле карточки, а не
// вешаем обработчик на каждую строку: строк в истории десятки, а карточек в разделе
// сотни. Клики внутри свёрнутого комментария («Показать целиком») и по кнопкам
// пропускаем - там своё действие.
function wireVisitOpen(root) {
  const openFrom = async (row) => {
    if (!row || row.dataset.opening === '1') return;
    row.dataset.opening = '1';
    try {
      const opened = await openBookingFromNotification({ id: row.dataset.visitId, date: row.dataset.visitDate });
      // false - записи нет на том дне (например, её уже перенесли в другой день из
      // другой вкладки). Молчать нельзя: человек нажал и ничего не увидел бы.
      if (!opened) showError('Не удалось открыть запись в расписании - обновите страницу');
    } catch (err) {
      showError(errorMessage(err, 'Не удалось открыть запись в расписании'));
    } finally {
      delete row.dataset.opening;
    }
  };
  root.addEventListener('click', (e) => {
    if (e.target.closest('.client-visit-comment, button, a')) return;
    openFrom(e.target.closest('.client-visit--openable'));
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.client-visit--openable');
    if (!row || e.target.closest('.client-visit-comment, button, a')) return;
    e.preventDefault();
    openFrom(row);
  });
}

// «Развернуть все» раскрывает разом ВСЕ карточки, а каждая тянет свою историю - на
// живой базе это сотня одновременных запросов, от которых сервер начнёт отвечать
// отказами, и человек увидит вместо истории красные строки. Поэтому грузим по
// очереди, не больше четырёх одновременно: раскрытие остаётся мгновенным (карточка
// открывается сразу, история дорисовывается по мере готовности), а поток запросов
// остаётся посильным.
const MAX_PARALLEL_HISTORY = 4;
let running = 0;
const queue = [];

function pump() {
  while (running < MAX_PARALLEL_HISTORY && queue.length > 0) {
    const job = queue.shift();
    running += 1;
    job().finally(() => {
      running -= 1;
      pump();
    });
  }
}

// ── Срок обновления стрижки в карточке клиента (Окно 59, 22.08.2026) ────────
// Основное место ввода - закрытие визита, здесь поправка задним числом («договорились
// на месяц, а он уезжает до октября»). Показываем то же, что записал мастер, плюс кто
// и когда это сделал: отдельной таблицы истории в v1 нет осознанно, «кто поставил
// последним» отвечает на вопрос владельца «с кого спросить».
function renewDaysText(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n % 7 === 0) {
    const weeks = n / 7;
    return `${weeks} ${weeks === 1 ? 'неделя' : weeks >= 2 && weeks <= 4 ? 'недели' : 'недель'}`;
  }
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'день' : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 'дня' : 'дней'}`;
}

function renewSectionMarkup(card) {
  const renew = card.renew ?? {};
  const daysText = renewDaysText(renew.days);
  const reason = renew.reason ? RENEW_REASON_SHORT[renew.reason] ?? renew.reason : null;
  const when = renew.setAt ? formatVisitDate(String(renew.setAt).slice(0, 10)) : '';
  const setBy = renew.setByName && when ? `${escapeHtml(renew.setByName)}, ${escapeHtml(when)}` : '';
  // Срока нет - так и пишем. Подставлять сюда «месяц по умолчанию» нельзя: месяц
  // ставится только осознанным выбором «не обсуждали», и выдуманный срок на экране
  // владельца выглядел бы как договорённость, которой не было
  const value = daysText
    ? `<b>${escapeHtml(daysText)}</b>${reason ? ` - ${escapeHtml(reason)}` : ''}`
    : '<span class="client-renew-empty">Срок не поставлен - появится, когда мастер закроет визит</span>';
  const note = renew.note ? `<div class="client-renew-note">${escapeHtml(renew.note)}</div>` : '';
  // Причины - радио-чипы, а не нативный select: тёмную тему CRM он не наследует
  // (правило проекта про свои темизированные виджеты), и список тут короткий -
  // пять пунктов читаются целиком, без раскрытия
  const cardId = escapeHtml(card.id);
  const options = Object.entries(RENEW_REASON_LABELS)
    .map(
      ([key, label]) => `<label class="renew-reason">
        <input type="radio" name="clientRenewReason-${cardId}" value="${escapeHtml(key)}"${key === renew.reason ? ' checked' : ''}>
        <span>${escapeHtml(label)}</span>
      </label>`
    )
    .join('');
  return `<div class="client-renew" data-client-renew>
    <div class="client-renew-head">
      <span class="client-renew-label">Приходит снова через</span>
      <span class="client-renew-value">${value}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-renew-edit>Изменить</button>
    </div>
    ${note}
    ${setBy ? `<div class="client-renew-setby">Поставил ${setBy}</div>` : ''}
    <div class="client-renew-form" data-renew-form hidden>
      <label class="client-renew-field"><span>дней</span>
        <input type="text" inputmode="numeric" autocomplete="off" data-renew-days value="${escapeHtml(renew.days ?? '')}" placeholder="28">
      </label>
      <div class="client-renew-field client-renew-field--wide"><span>почему так</span>
        <div class="renew-reasons" data-renew-reasons>${options}</div>
      </div>
      <label class="client-renew-field client-renew-field--wide"><span>комментарий</span>
        <input type="text" maxlength="300" autocomplete="off" data-renew-note value="${escapeHtml(renew.note ?? '')}">
      </label>
      <button type="button" class="btn btn-primary btn-sm" data-renew-save>Сохранить срок</button>
      <p class="payroll-note" data-renew-result hidden></p>
    </div>
  </div>`;
}

// Правка срока из карточки. Роут тот же, что и у закрытия визита по смыслу, но свой
// (PATCH /clients/:id/renew) - здесь нет брони, к которой можно было бы прицепиться
function wireRenewEditor(root, clientId) {
  const host = root.querySelector('[data-client-renew]');
  if (!host) return;
  const form = host.querySelector('[data-renew-form]');
  host.querySelector('[data-renew-edit]')?.addEventListener('click', () => {
    if (form) form.hidden = !form.hidden;
  });
  host.querySelector('[data-renew-save]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const result = host.querySelector('[data-renew-result]');
    const days = Number(host.querySelector('[data-renew-days]')?.value);
    const reason = host.querySelector('[data-renew-reasons] input:checked')?.value;
    const note = host.querySelector('[data-renew-note]')?.value ?? '';
    setButtonBusy(btn, true);
    try {
      const out = await apiSend(`/clients/${encodeURIComponent(clientId)}/renew`, 'PATCH', {
        renew: { days, reason, note },
      });
      if (!out.ok) throw out;
      const saved = out.data?.renew ?? {};
      const valueEl = host.querySelector('.client-renew-value');
      const daysText = renewDaysText(saved.days);
      const short = saved.reason ? RENEW_REASON_SHORT[saved.reason] ?? saved.reason : null;
      if (valueEl && daysText) valueEl.innerHTML = `<b>${escapeHtml(daysText)}</b>${short ? ` - ${escapeHtml(short)}` : ''}`;
      if (result) {
        result.hidden = false;
        result.textContent = 'Срок сохранён';
      }
      showSuccess('Срок сохранён');
    } catch (err) {
      if (result) {
        result.hidden = false;
        result.textContent = errorMessage(err, 'Не удалось сохранить срок');
      }
    } finally {
      setButtonBusy(btn, false);
    }
  });
}

function loadClientHistory(details) {
  const body = details.querySelector('[data-client-body]');
  if (!body || details.dataset.loaded === '1') return;
  details.dataset.loaded = '1';
  showSkeleton(body, 3);
  queue.push(() => fetchClientHistory(details, body));
  pump();
}

async function fetchClientHistory(details, body) {
  try {
    const card = await fetchJson(`/clients/${encodeURIComponent(details.dataset.clientId)}`);
    const visits = card.visits.length
      ? card.visits.map(visitMarkup).join('')
      : '<p class="payroll-note">Визитов пока не было</p>';
    const actions = [];
    // «Записать снова» - та же кнопка и тот же контракт, что в карточке из списка
    // «стоит позвонить» (openClientCard выше): мастер и услуги берутся с последнего
    // визита, дата и время выбираются заново на актуальной доступности.
    if (card.lastVisit && typeof window.openRebookBooking === 'function') {
      actions.push('<button class="btn btn-primary btn-sm" type="button" data-rebook>Записать снова</button>');
    }
    // Кнопки связи - ровно те же четыре, что в разделе «Уведомления»: сотрудник уже
    // знает этот ряд и не должен учить второй. Прежняя одинокая «Позвонить» здесь
    // была частным случаем этого набора и заменена им целиком.
    //
    // Текст подставляем только когда есть, о чём писать: у клиента с ближайшей
    // запланированной записью это напоминание о ней, у остальных - пустой чат, а не
    // выдуманное приглашение от лица барбершопа.
    const upcoming = nextPlannedVisit(card.visits);
    const messageText = upcoming
      ? clientMessageText({
        clientName: card.name,
        date: upcoming.date,
        startTime: upcoming.startTime,
        masterName: upcoming.masterName,
        serviceNames: upcoming.services.map((sv) => sv.name).join(', '),
        status: upcoming.status,
      })
      : '';
    actions.push(messengerButtonsHtml(card.phone, messageText));
    body.innerHTML = `${renewSectionMarkup(card)}${visits}<div class="client-card-actions">${actions.join('')}</div>`;
    wireVisitOpen(body);
    wireRenewEditor(body, card.id);
    wireMessengerLinks(body); // MAX: ссылки на чат по номеру у него нет, кнопка копирует номер
    const rebookBtn = body.querySelector('[data-rebook]');
    if (rebookBtn) {
      rebookBtn.addEventListener('click', () => {
        window.openRebookBooking(
          card.lastVisit.masterId,
          card.lastVisit.masterName || '',
          card.name,
          card.phone,
          card.lastVisit.services.map((s) => s.id)
        );
      });
    }
  } catch (err) {
    // Повторная попытка при следующем раскрытии: снимаем отметку «загружено», иначе
    // разовый сбой сети запирал бы карточку с текстом ошибки до перезагрузки страницы.
    details.dataset.loaded = '';
    body.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(err, 'Не удалось загрузить историю клиента'))}</p>`;
    showError(errorMessage(err, 'Не удалось загрузить историю клиента'));
  }
}

// Счётчик визитов без телефона за всё время (GET /analytics/unlinked). Держим в
// модуле, а не в разметке: он приходит отдельным запросом и не должен задерживать
// сам список - пока счётчик едет, список уже виден, а число просто дорисуется
let unlinkedVisitsCount = 0;

async function loadUnlinkedCount() {
  try {
    const data = await fetchJson('/analytics/unlinked');
    unlinkedVisitsCount = Number(data?.visits) || 0;
    paintClients();
  } catch {
    // Счётчик - справка рядом с основным списком. Не приехал (нет прав, сеть) -
    // молчим: показывать ошибку вместо числа значило бы кричать о неважном
    unlinkedVisitsCount = 0;
  }
}

function paintClients() {
  const list = el('clientsList');
  const count = el('clientsCount');
  if (!list) return;
  const visible = filterClients(clientsCache, el('clientsSearch')?.value);
  if (count) {
    // Визиты без телефона (правка Влада 22.08.2026: «в записях клиентов их не
    // учитывать, но считать, сколько таких»). В самом списке таких людей нет и не
    // будет - без номера система намеренно не связывает их визиты между собой, и
    // строка на каждый приход означала бы десяток «разных» людей с одним именем.
    // Но и делать вид, что этих визитов не было, нельзя - поэтому число стоит рядом
    // с «Всего N», отдельным фактом, а не строкой списка
    const unlinked = unlinkedVisitsCount > 0 ? ` · без телефона: ${unlinkedVisitsCount}` : '';
    count.textContent =
      clientsCache.length === 0
        ? ''
        : visible.length === clientsCache.length
          ? `Всего ${clientsCache.length}${unlinked}`
          : `Найдено ${visible.length} из ${clientsCache.length}${unlinked}`;
  }
  if (clientsCache.length === 0) {
    list.innerHTML = '<p class="payroll-note">Клиентов пока нет. Клиент появляется здесь сам, когда его записали с номером телефона</p>';
    return;
  }
  if (visible.length === 0) {
    list.innerHTML = '<p class="payroll-note">Никого не нашли. Попробуйте часть имени или последние цифры номера</p>';
    return;
  }
  list.innerHTML = visible.map(clientCardMarkup).join('');
  list.querySelectorAll('.client-card').forEach((details) => {
    details.addEventListener('toggle', () => {
      if (details.open) loadClientHistory(details);
    });
  });
  // Кнопка появляется только когда в списке реально есть карточки - у пустого списка
  // и у «никого не нашли» разворачивать нечего
  initCrmNavigationPanels();
}

// Раздел уже открывали хоть раз в этой сессии. От этого зависит, делает ли что-то
// кнопка мягкого обновления: тянуть всю базу клиентов ради раздела, в который человек
// ни разу не заходил, - лишний тяжёлый запрос на каждое нажатие «Обновить».
let sectionLoaded = false;

// Перечитывает базу клиентов. Идемпотентна (fetch + innerHTML, без навешивания
// обработчиков на статичные узлы) - её можно звать из кнопки мягкого обновления
// столько раз, сколько нужно, тот же контракт, что у renderRiskList выше.
export async function renderClientsSection() {
  const list = el('clientsList');
  if (!list) return; // страница без раздела «Клиенты» - тихий no-op
  if (!sectionLoaded) return; // раздел ни разу не открывали - обновлять нечего
  // Счётчик визитов без телефона перечитываем вместе со списком: он живёт в той же
  // строке и от тех же данных, устареть отдельно от списка не должен
  await Promise.all([loadClients(list), loadUnlinkedCount()]);
}

async function loadClients(list) {
  showSkeleton(list, 3);
  try {
    clientsCache = await fetchJson('/clients?all=true');
    paintClients();
  } catch (err) {
    list.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(err, 'Не удалось загрузить базу клиентов'))}</p>`;
    showError(errorMessage(err, 'Не удалось загрузить базу клиентов'));
  }
}

export function wireClientsSection() {
  const search = el('clientsSearch');
  if (!search) return; // страница без раздела - обработчики вешать не на что
  search.addEventListener('input', paintClients);

  // Данные тянем в момент первого захода в раздел, а не при загрузке страницы: вся
  // база клиентов - самый тяжёлый запрос кабинета, а владелец заходит сюда далеко не
  // каждую сессию. Тот же приём, что у «Расписания» (crm:section, assets/crm-schedule-views.js).
  document.addEventListener('crm:section', (e) => {
    if (e.detail?.section !== 'clients' || sectionLoaded) return;
    sectionLoaded = true;
    loadClients(el('clientsList'));
    loadUnlinkedCount();
  });
}
