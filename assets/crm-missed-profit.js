// «Недополученная прибыль» - карточка в разделе «Финансы» владельца (Окно 59,
// 22.08.2026).
//
// Почему в «Финансах», а не в «Аналитике» (решение Влада, не переигрывать): «Аналитика»
// отвечает процентами на вопрос «как ведут себя люди», а здесь рубли, и владелец ставит
// их мысленно рядом с выручкой. В «Аналитике» цифра читается как справка, в «Финансах» -
// как удар.
//
// Ни одна цифра тут не считается: считает сервер (GET /finance/missed-profit,
// api/routes/missed-profit.js), фронт рисует. Расходящаяся формула в двух местах - та
// же ошибка, что уже ловили в зарплате мастера (Окно 37).
//
// Честность подписей - главное в этом файле:
//   отвал и неявки подписаны ПОТЕРЯМИ (визитов не было, деньги не пришли);
//   разрежённость - ПОТЕНЦИАЛОМ. Клиент не обещал ходить чаще, он согласился на свой
//   срок; «вы потеряли» на нём было бы враньём.
import { fetchJson } from './crm-auth.js';
import { formatMoney } from './crm-shared.js';
import { errorMessage } from './crm-toast.js';
import { periodStartStr } from './crm-payroll.js';
import { messengerButtonsHtml, wireMessengerLinks } from './crm-notifications.js';
import { renewReasonShort } from './renew-reason.js';
import { T, Tc, P, C, tenantName } from './crm-terms.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Периоды - те же, что у «Выручки» рядом: владелец сравнивает эти две карточки одним
// взглядом, и разные наборы периодов заставляли бы его пересчитывать в уме
const PERIODS = [
  { key: 'day', radio: 'mp-day', host: 'mpDay', label: 'сегодня' },
  { key: 'week', radio: 'mp-week', host: 'mpWeek', label: 'за неделю' },
  { key: 'month', radio: 'mp-month', host: 'mpMonth', label: 'за месяц' },
  { key: 'quarter', radio: 'mp-quarter', host: 'mpQuarter', label: 'за квартал' },
  { key: 'year', radio: 'mp-year', host: 'mpYear', label: 'за год' },
];

const SKELETON = '<div class="crm-skeleton" role="status" aria-label="Загружаю данные"><span class="crm-skeleton__row"></span><span class="crm-skeleton__row"></span></div>';

const cache = new Map();

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rangeFor(periodKey) {
  const to = todayStr();
  const from = periodKey === 'day' ? to : periodStartStr(periodKey);
  return { from, to };
}

async function loadCached(path) {
  if (cache.has(path)) return cache.get(path);
  const data = await fetchJson(path);
  cache.set(path, data);
  return data;
}

// Сумма, которой нет (за период не было ни визитов, ни неявок), показывается прочерком,
// а не нулём: «вы ничего не упустили» и «считать не из чего» - разные сообщения
// владельцу. Тот же принцип, что у percentOf в аналитике
function moneyText(sum) {
  return sum === null || sum === undefined ? '—' : formatMoney(sum);
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function statCard({ label, value, note, lead = false, action = null, major = false }) {
  const actionHtml = action
    ? `<button type="button" class="sc-action" data-mp-kind="${escapeHtml(action.kind)}" data-mp-from="${escapeHtml(action.from)}" data-mp-to="${escapeHtml(action.to)}">${escapeHtml(action.text)}</button>`
    : '';
  return `<div class="stat-card${lead ? ' stat-card--net' : ''}${major ? ' stat-card--major' : ''}">
    <div class="sc-label">${escapeHtml(label)}</div>
    <div class="sc-value">${escapeHtml(value)}</div>
    ${note ? `<div class="sc-note">${escapeHtml(note)}</div>` : ''}
    ${actionHtml}
  </div>`;
}

export function missedProfitHtml(data, periodLabel) {
  if (data.total === null || data.total === undefined) {
    return `<p class="payroll-note">Визитов ${escapeHtml(periodLabel)} не было - считать пока не из чего</p>`;
  }
  const { from, to } = data;
  const counts = data.counts ?? { overdue: 0, sparse: 0, noShow: 0 };

  const totalCard = statCard({
    lead: true,
    label: 'Прошло мимо кассы',
    value: moneyText(data.total),
    note: `${periodLabel}, из них потеряно ${formatMoney((data.lostLapsed ?? 0) + (data.lostNoShow ?? 0))}`,
  });

  const lapsed = {
    sum: data.lostLapsed,
    label: 'Не вернулись в срок',
    value: moneyText(data.lostLapsed),
    note: counts.overdue > 0 ? `${counts.overdue} ${C('client', counts.overdue)} - потеряно` : 'Таких клиентов нет',
    action: counts.overdue > 0 ? { kind: 'overdue', from, to, text: 'Кому звонить сейчас' } : null,
  };

  // Формулировка «если бы ходили по рекомендованному сроку» - не украшение, а суть:
  // это НЕ потеря, клиент согласился на свой срок и ничего салону не должен
  const sparse = {
    sum: data.potentialSparse,
    label: P('missed.sparseLabel'),
    value: moneyText(data.potentialSparse),
    note: counts.sparse > 0 ? `${counts.sparse} ${C('client', counts.sparse)} - столько принесли бы по рекомендованному сроку` : 'Таких клиентов нет',
    action: counts.sparse > 0 ? { kind: 'sparse', from, to, text: 'Кому объяснить срок' } : null,
  };

  // Действие по неявкам (04.09.2026, решение владельца). Раньше на самой большой потере
  // экрана продукт молчал: сумма есть, делать нечего. Теперь тот же приём, что у
  // невернувшихся - поимённый список и кнопки связи с готовым текстом: сначала человеку
  // пишут в мессенджер, а звонит администратор уже тому, кто ответил
  const noShow = {
    sum: data.lostNoShow,
    label: 'Неявки',
    value: moneyText(data.lostNoShow),
    note: counts.noShow > 0 ? `${counts.noShow} ${C('booking', counts.noShow)} - потеряно` : 'Неявок не было',
    action: counts.noShow > 0 ? { kind: 'noshow', from, to, text: 'Кому напомнить о себе' } : null,
  };

  // 04.09.2026 (осмотр кабинета владельцем). Три причины потери стояли в фиксированном
  // порядке и с одинаковым визуальным весом, хотя различаются на порядок: в демо-данных
  // неявки дают 219 500 из 235 500, а «не вернулись в срок» - 16 000, и взгляд владельца
  // первым попадал на наименьшую потерю. Теперь порядок и вес задаёт сама сумма:
  // наибольшая идёт первой и набрана крупнее (stat-card--major), нулевые и пустые
  // уходят в конец. Подписи, формулировки и действия при этом не трогаются
  const reasons = [lapsed, sparse, noShow].sort((a, b) => (b.sum ?? -1) - (a.sum ?? -1));
  const reasonCards = reasons
    .map((r, i) => statCard({ ...r, major: i === 0 && Boolean(r.sum) }))
    .join('');

  return `
    <div class="stat-cards">${totalCard}</div>
    <div class="stat-cards">${reasonCards}</div>
    <p class="payroll-note mp-legend">${P('missed.legend')}</p>
    <div class="mp-list" id="mpList" hidden></div>
  `;
}

function dateText(iso) {
  return iso ? String(iso).split('-').reverse().join('.') : '';
}

// Текст сообщения клиенту, который пропустил срок. Ни скидок, ни акций система не
// придумывает - только повод написать; что предлагать, решает салон
export function overdueMessageText(client) {
  const name = client?.name ? `${client.name}, ` : '';
  return `Здравствуйте, ${name}это ${tenantName()}. ${P('msg.refresh')}`;
}

const LIST_TITLES = {
  overdue: 'Кому звонить сейчас',
  sparse: 'Кому объяснить срок',
  noshow: 'Кому напомнить о себе',
};

// Текст по неявке. Ни упрёка, ни счёта за пропуск: система предлагает написать первой,
// чтобы администратор звонил уже тому, кто ответил. Что предлагать дальше - скидку,
// предоплату, другое время - решает салон, продукт за него не придумывает
export function noShowMessageText(client) {
  const name = client?.name ? `${client.name}, ` : '';
  const when = client?.date ? ` ${dateText(client.date)}` : '';
  return `Здравствуйте, ${name}это ${tenantName()}. Вы не смогли прийти${when} - подобрать вам новое время?`;
}

// Состояние разговора по неявке. Вопрос владельца 04.09.2026: «а если клиент не
// ответит - игнорить его?». Нет: молчащий остаётся в списке со своей подписью и своим
// местом в очереди работы. Подпись отвечает ровно на один вопрос - что владельцу
// делать с этой строкой прямо сейчас
const DECLINE_REASONS = {
  price: 'дорого',
  time: 'неудобное время',
  other_place: 'ходит в другое место',
  changed_mind: 'просто передумал',
};

export function followupChip(client) {
  const map = {
    replied: [P('missed.repliedNoBooking'), 'mp-state--replied'],
    silent: [`написали, молчит ${client.silentDays ?? 0} ${plural(client.silentDays ?? 0, 'день', 'дня', 'дней')} - звоните сами`, 'mp-state--silent'],
    queued: ['письмо в очереди - подождите ответа', 'mp-state--quiet'],
    no_channel: ['бота у него нет - только звонок', 'mp-state--silent'],
    none: ['письма не было - только звонок', 'mp-state--silent'],
    rebooked: [P('missed.rebooked', { date: dateText(client.rebookedDate) }), 'mp-state--done'],
    declined: [
      client.reason ? `не планирует: ${DECLINE_REASONS[client.reason] ?? client.reason}` : 'ответил: пока не планирует',
      'mp-state--quiet',
    ],
  };
  const found = map[client.state];
  if (!found) return '';
  return `<span class="mp-state ${found[1]}">${escapeHtml(found[0])}</span>`;
}

export function listHtml(data, kind) {
  const clients = data.clients ?? [];
  const title = LIST_TITLES[kind] ?? LIST_TITLES.overdue;
  if (clients.length === 0) return `<p class="payroll-note">${escapeHtml(P('analytics.noSuchClients', { title }))}</p>`;

  const rows = clients
    .map((c) => {
      const phone = c.phone || '';
      // У просроченного - на сколько опоздал и сколько это стоило; у разрежённого -
      // сколько визитов недодал. Сумма стоит напротив имени: список нужен, чтобы
      // решить, кому звонить первым, а не чтобы полюбоваться цифрой сверху
      const detail =
        kind === 'overdue'
          ? `был ${dateText(c.lastVisit)} - опоздал на ${c.daysLate} ${plural(c.daysLate, 'день', 'дня', 'дней')}`
          : kind === 'noshow'
            ? `не пришёл ${dateText(c.date)} - время держали, деньги не пришли`
            : `${c.shortfallVisits} ${plural(c.shortfallVisits, 'визит', 'визита', 'визитов')} мимо, договаривались на ${c.renewDays} ${plural(c.renewDays, 'день', 'дня', 'дней')}${c.renewReason ? ` (${renewReasonShort()[c.renewReason] ?? c.renewReason})` : ''}`;
      const state = kind === 'noshow' ? followupChip(c) : '';
      return `<div class="an-lapsed-row">
        <div class="an-lapsed-who">
          <span class="mp-name">${escapeHtml(c.name || 'Без имени')}</span>
          <span class="an-lapsed-when">${escapeHtml(detail)}</span>
          ${state}
        </div>
        <div class="mp-amount">${escapeHtml(formatMoney(c.amount))}</div>
        <div class="an-lapsed-actions">${phone ? messengerButtonsHtml(phone, kind === 'overdue' ? overdueMessageText(c) : kind === 'noshow' ? noShowMessageText(c) : '') : ''}</div>
      </div>`;
    })
    .join('');

  return `
    <div class="an-lapsed-head">
      <span>${escapeHtml(title)}</span>
      <button type="button" class="btn btn-ghost btn-sm" id="mpListClose">Скрыть</button>
    </div>
    ${rows}
    ${data.truncated ? '<p class="payroll-note">Показаны первые 200</p>' : ''}
  `;
}

async function openList(btn) {
  const host = document.getElementById('mpList');
  if (!host) return;
  const kind = btn.dataset.mpKind;
  host.hidden = false;
  host.innerHTML = SKELETON;
  host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    const path = `/finance/missed-profit/clients?from=${encodeURIComponent(btn.dataset.mpFrom)}&to=${encodeURIComponent(btn.dataset.mpTo)}&kind=${encodeURIComponent(kind)}`;
    host.innerHTML = listHtml(await loadCached(path), kind);
    wireMessengerLinks(host);
  } catch (e) {
    host.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(e))}</p>`;
  }
}

async function paint(period) {
  const node = document.getElementById(period.host);
  if (!node) return;
  node.innerHTML = SKELETON;
  const { from, to } = rangeFor(period.key);
  try {
    const data = await loadCached(`/finance/missed-profit?from=${from}&to=${to}`);
    node.innerHTML = missedProfitHtml(data, period.label);
  } catch (e) {
    // Ошибка на месте цифр, не тостом поверх: владелец должен видеть, что сумма НЕ
    // показана, а не думать, что ноль это факт
    node.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(e))}</p>`;
  }
}

function checkedPeriod() {
  return PERIODS.find((p) => document.getElementById(p.radio)?.checked) ?? PERIODS[0];
}

export async function renderMissedProfit() {
  const period = checkedPeriod();
  if (document.getElementById(period.host)) await paint(period);
}

// Мягкое обновление кабинета (кнопка «обновить», Окно 45): кэш периодов сбрасываем,
// иначе владелец видел бы ту же картину из памяти вкладки
export async function refreshMissedProfit() {
  cache.clear();
  await renderMissedProfit();
}

export function wireMissedProfit() {
  const host = document.getElementById(PERIODS[0].host);
  if (!host) return; // страница без карточки
  for (const period of PERIODS) {
    document.getElementById(period.radio)?.addEventListener('change', () => paint(period));
  }
  const card = host.closest('details.staff-card');
  // Делегированный обработчик на карточку: содержимое перерисовывается на каждой смене
  // периода, и вешать обработчики на каждую кнопку заново значило бы их задваивать
  card?.addEventListener('click', (e) => {
    const listBtn = e.target.closest('[data-mp-kind]');
    if (listBtn) return void openList(listBtn);
    if (e.target.closest('#mpListClose')) {
      const list = document.getElementById('mpList');
      if (list) { list.hidden = true; list.innerHTML = ''; }
    }
  });
  // Данные тянем в момент первого раскрытия карточки, а не на загрузке страницы: это
  // тяжёлый расчёт по всей базе клиентов, и делать его ради свёрнутого блока незачем
  card?.addEventListener('toggle', () => {
    if (card.open) renderMissedProfit();
  });
}
