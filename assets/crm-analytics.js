// Раздел «Аналитика» владельца (22.08.2026, задача Влада: «возвращаемость клиентов
// по сотрудникам» и «в „Как приходят клиенты“ добавить откуда - яндекс, 2гис и т.д.»).
//
// До этого модуля раздел был единственным местом кабинета без единого запроса к
// серверу: обе карточки стояли статичной вёрсткой «00% пример» прямо в crm-owner.html
// с самого Окна 42. Теперь цифры настоящие - считает их сервер (GET
// /analytics/retention, GET /analytics/sources, api/routes/analytics.js), фронт только
// рисует. Ни одна цифра здесь не вычисляется заново: расходящаяся формула в двух
// местах - та же ошибка, что уже ловили в зарплате мастера (Окно 37).
//
// Переключатели периодов остались прежними (радио + `.seg-panel`, чистый CSS, как в
// «Финансах» и «Расписании») - модуль подменяет только содержимое панелей. Данные
// каждого периода тянутся при первом показе и кэшируются: владелец щёлкает вкладками
// туда-сюда, и повторно дёргать сервер на каждый щелчок незачем.
import { fetchJson } from './crm-auth.js';
import { errorMessage } from './crm-toast.js';
// Подписи каналов («Яндекс Карты», «2ГИС», …) - один словарь на весь проект
// (assets/client-source.js). Сервер отдаёт ключи, человеческие названия живут здесь
import { CLIENT_SOURCE_LABELS } from './client-source.js';
import { firedLabel } from './crm-shared.js';
// Кнопки связи (WhatsApp/Telegram/MAX/СМС/Позвонить) - тот же набор, что в
// «Уведомлениях» и в истории клиента. Своего второго набора кнопок в проекте нет
import { messengerButtonsHtml, wireMessengerLinks } from './crm-notifications.js';
import { T, Tc, P, C, tenantName } from './crm-terms.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Периоды - ровно те, что уже нарисованы переключателями в crm-owner.html. Список
// закрытый и с обеих сторон одинаковый: сервер принимает только эти значения
// (RETENTION_MONTHS / SOURCE_MONTHS, api/routes/analytics.js).
const RETENTION_PERIODS = [
  { months: 3, radio: 'rt1-3', host: 'anRet3', label: 'за 3 месяца' },
  { months: 6, radio: 'rt1-6', host: 'anRet6', label: 'за 6 месяцев' },
  { months: 12, radio: 'rt1-12', host: 'anRet12', label: 'за год' },
  { months: 24, radio: 'rt1-24', host: 'anRet24', label: 'за 2 года' },
  { months: 36, radio: 'rt1-36', host: 'anRet36', label: 'за 3 года' },
];

// Доля обсуждённых сроков (Окно 59, 22.08.2026). Периодов три, а не пять: метрика про
// текущую работу мастеров, и «за три года» тут отвечало бы на вопрос, который никто не
// задаёт. Все три значения входят в RETENTION_MONTHS, которые принимает сервер
const DISCUSSED_PERIODS = [
  { months: 3, radio: 'rd1-3', host: 'anDisc3', label: 'за 3 месяца' },
  { months: 6, radio: 'rd1-6', host: 'anDisc6', label: 'за 6 месяцев' },
  { months: 12, radio: 'rd1-12', host: 'anDisc12', label: 'за год' },
];

const SOURCE_PERIODS = [
  { months: 1, radio: 'wi1-month', host: 'anSrc1', label: 'за месяц' },
  { months: 3, radio: 'wi1-3m', host: 'anSrc3', label: 'за 3 месяца' },
  { months: 6, radio: 'wi1-6m', host: 'anSrc6', label: 'за полгода' },
  { months: 12, radio: 'wi1-year', host: 'anSrc12', label: 'за год' },
];

const SKELETON = '<div class="crm-skeleton" role="status" aria-label="Загружаю данные"><span class="crm-skeleton__row"></span><span class="crm-skeleton__row"></span></div>';

// Кэш ответов по адресу запроса. Чистится кнопкой мягкого обновления - см.
// refreshAnalytics ниже, иначе владелец жал бы «обновить» и видел вчерашние цифры
const cache = new Map();

async function loadCached(path) {
  if (cache.has(path)) return cache.get(path);
  const data = await fetchJson(path);
  cache.set(path, data);
  return data;
}

// Процент, которого нет (не из чего считать), показываем прочерком, а не нулём:
// «0% вернулись» и «за период не было ни одного клиента» - разные факты, и подменять
// второй первым нельзя. Тот же принцип, что на сервере (percentOf → null)
function pctText(pct) {
  return pct === null || pct === undefined ? '—' : `${pct}%`;
}

// «12 из 30» - и число, и база рядом с ним. Без базы процент нечитаем: 100% от двух
// клиентов и 100% от двухсот означают для владельца совершенно разное
function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function statCard({ label, value, note, lead = false, action = null }) {
  // action - кнопка «N не вернулись» под цифрой. Кнопка, а не ссылка: никакой
  // навигации не происходит, список раскрывается тут же
  const actionHtml = action
    ? `<button type="button" class="sc-action" data-lapsed-months="${escapeHtml(action.months)}" data-lapsed-master="${escapeHtml(action.masterId)}" data-lapsed-title="${escapeHtml(label)}" title="Были один раз и больше месяца не приходили">${escapeHtml(action.count)} не ${plural(action.count, 'вернулся', 'вернулись', 'вернулись')}</button>`
    : '';
  return `<div class="stat-card${lead ? ' stat-card--net' : ''}">
    <div class="sc-label">${escapeHtml(label)}</div>
    <div class="sc-value">${escapeHtml(value)}</div>
    ${note ? `<div class="sc-note">${escapeHtml(note)}</div>` : ''}
    ${actionHtml}
  </div>`;
}

// ── Возвращаемость ──────────────────────────────────────────────────────────
// Правка Влада 22.08.2026: «куча непонятных надписей, минимализм нарушен». Абзацы-
// пояснения (чем цифра мастера отличается от цифры салона, почему визит без телефона
// не считается) убраны из экрана: цифра и короткая подпись под ней - всё. Смысл, ради
// которого эти абзацы писались, никуда не делся - он остался в комментариях кода и в
// самих формулировках подписей, но читать лекцию каждый раз, когда владелец открыл
// раздел, незачем.
export function retentionHtml(data, periodLabel) {
  const { salon, masters = [], unlinkedVisits = 0 } = data;
  if (!salon || salon.clients === 0) {
    return `<p class="payroll-note">Визитов ${escapeHtml(periodLabel)} не было</p>`;
  }

  // Кнопка «не вернулись» на карточке - вход в список поимённо (см. wireLapsed).
  // Число на ней - те же клиенты, что не попали в процент: пришли один раз
  const lapsedSalon = salon.clients - salon.returned;
  const salonCard = statCard({
    lead: true,
    label: 'Вернулись повторно',
    value: pctText(salon.pct),
    note: `${salon.returned} из ${salon.clients}`,
    action: lapsedSalon > 0 ? { months: data.months, masterId: '', count: lapsedSalon } : null,
  });

  const masterCards = masters
    .map((m) =>
      statCard({
        // Дата увольнения в подписи (22.08.2026): «(не работает)» не отвечало на
        // вопрос «а когда он ушёл» - без этого цифры за период не с чем сопоставить
        label: m.employed ? m.name : `${m.name} (${firedLabel(m).toLowerCase()})`,
        value: pctText(m.pct),
        note: m.clients === 0 ? 'Нет визитов' : `${m.returned} из ${m.clients}`,
        action: m.clients - m.returned > 0 ? { months: data.months, masterId: m.masterId, count: m.clients - m.returned } : null,
      })
    )
    .join('');

  // Заглушка «без телефона» (правка Влада 22.08.2026). Такие визиты были и раньше -
  // они просто молчали текстовой оговоркой в подвале. Теперь это карточка в общем ряду:
  // визит в статистике учтён, а то, что человека за ним не опознать, видно сразу и не
  // выглядит как ошибка расчёта
  const unlinkedCard = unlinkedVisits > 0
    ? statCard({ label: 'Без телефона', value: String(unlinkedVisits), note: P('analytics.unlinkedNote') })
    : '';

  // Клиенты, которые были один раз совсем недавно, в проценте не участвуют: месяца с
  // их визита ещё не прошло, и судить о них рано (правка Влада 22.08.2026 - «он что,
  // каждый день стричься должен?»). Молча выкинуть их из расчёта нельзя - тогда цифры
  // не сойдутся с тем, что владелец видит в записях, поэтому они стоят своей карточкой
  const waiting = salon.waiting ?? 0;
  const waitingCard = waiting > 0
    ? statCard({ label: 'Пришли недавно', value: String(waiting), note: 'Ещё рано судить, ждём месяц' })
    : '';

  return `
    <div class="stat-cards">${salonCard}</div>
    ${masterCards || unlinkedCard || waitingCard ? `<div class="stat-cards">${masterCards}${waitingCard}${unlinkedCard}</div>` : ''}
    <div class="an-lapsed" id="anLapsed" hidden></div>
  `;
}

// ── Как приходят клиенты ────────────────────────────────────────────────────
export function sourcesHtml(data, periodLabel) {
  const { total = 0, rows = [] } = data;
  if (total === 0) {
    return `<p class="payroll-note">${escapeHtml(P('analytics.noBookings', { period: periodLabel }))}</p>`;
  }

  const cards = rows
    .map((row) =>
      statCard({
        // key === null - записи, у которых источник не проставлен. Это не канал, и
        // подписан он честно: клиент мог прийти по звонку, а мог просто остаться
        // незаполненным в карточке
        label: row.key ? CLIENT_SOURCE_LABELS[row.key] ?? row.key : 'Источник не указан',
        value: pctText(row.pct),
        note: `${row.count} ${C('booking', row.count)}`,
      })
    )
    .join('');

  return `
    <div class="stat-cards">${cards}</div>
    <p class="payroll-note">${escapeHtml(P('analytics.totalBookings', { total }))}</p>
  `;
}

// ── Доля обсуждённых сроков по мастерам ─────────────────────────────────────
// Что именно тут за цифра и почему не «заполненность» - см. computeRenewDiscussed
// (api/routes/analytics.js). Коротко: поле обязательное, поэтому заполнено всегда;
// смысл в доле тех клиентов, с кем срок реально проговорили, а не поставили месяц по
// умолчанию. Вариант «не обсуждали» - законный ответ мастера, поэтому подпись под
// цифрой говорит о разговоре, а не о нарушении.
export function discussedHtml(data, periodLabel) {
  const { salon, masters = [] } = data;
  if (!salon || salon.clients === 0) {
    return `<p class="payroll-note">Визитов ${escapeHtml(periodLabel)} не было</p>`;
  }
  const salonCard = statCard({
    lead: true,
    label: 'Срок проговорили',
    value: pctText(salon.pct),
    note: `${salon.discussed} из ${salon.clients}`,
  });
  const masterCards = masters
    .map((m) =>
      statCard({
        label: m.employed ? m.name : `${m.name} (${firedLabel(m).toLowerCase()})`,
        value: pctText(m.pct),
        note: m.clients === 0 ? P('analytics.noClients') : `${m.discussed} из ${m.clients}`,
      })
    )
    .join('');
  return `
    <div class="stat-cards">${salonCard}</div>
    ${masterCards ? `<div class="stat-cards">${masterCards}</div>` : ''}
    <p class="payroll-note">${P('analytics.renewDefaultNote')}</p>
  `;
}

// ── Кто не вернулся: список поимённо ────────────────────────────────────────
// Открывается кнопкой на карточке (правка Влада 22.08.2026: «нужна возможность
// перехода на клиентов, которые не вернулись»). Список рисуется под карточками, а не
// в модалке: это продолжение той же цифры, а не отдельный экран.
function lapsedListHtml(data, title) {
  const { clients = [], truncated } = data;
  if (clients.length === 0) return `<p class="payroll-note">${escapeHtml(P('analytics.noSuchClients', { title }))}</p>`;
  const rows = clients
    .map((c) => {
      const phone = c.phone || '';
      const when = c.lastVisit ? c.lastVisit.split('-').reverse().join('.') : '';
      return `<div class="an-lapsed-row">
        <div class="an-lapsed-who">
          <button type="button" class="an-lapsed-name" data-client-phone="${escapeHtml(phone)}">${escapeHtml(c.name || 'Без имени')}</button>
          <span class="an-lapsed-when">${escapeHtml(when)}</span>
        </div>
        <div class="an-lapsed-actions">${phone ? messengerButtonsHtml(phone, lapsedMessageText(c)) : ''}</div>
      </div>`;
    })
    .join('');
  return `
    <div class="an-lapsed-head">
      <span>${escapeHtml(title)}</span>
      <button type="button" class="btn btn-ghost btn-sm" id="anLapsedClose">Скрыть</button>
    </div>
    ${rows}
    ${truncated ? '<p class="payroll-note">Показаны первые 200</p>' : ''}
  `;
}

// Текст сообщения клиенту, который был один раз и не вернулся. Ни скидок, ни акций
// система не придумывает - только повод написать; что предлагать, решает салон
export function lapsedMessageText(client) {
  const name = client?.name ? `${client.name}, ` : '';
  return `Здравствуйте, ${name}это ${tenantName()}. ${P('msg.comeBack')}`;
}

// Переход в карточку клиента (правка Влада 22.08.2026). Своего экрана клиента
// аналитика не рисует: раздел «Клиенты» уже умеет всё - историю визитов, деньги,
// связь, повторную запись. Поэтому «переход» здесь буквальный - тот же клик по пункту
// меню, что сделал бы человек, плюс поиск по номеру и раскрытая карточка.
async function goToClient(phone) {
  document.querySelector('.app-nav-item[data-section="clients"]')?.click();
  const search = document.getElementById('clientsSearch');
  if (!search) return;
  search.value = phone;
  search.dispatchEvent(new Event('input', { bubbles: true }));
  // Раздел мог открываться впервые - список тянется с сервера, карточки появятся не
  // мгновенно. Ждём их, но недолго: не дождались - человек уже в разделе с готовым
  // поиском по номеру, дальше он справится сам
  for (let i = 0; i < 40; i++) {
    const card = document.querySelector('.client-card');
    if (card) {
      card.open = true;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Список «кто не вернулся» - под карточками, один на раздел: открыли список по другому
// мастеру - предыдущий заменяется, а не копится вторым блоком
async function openLapsed(btn) {
  const host = document.getElementById('anLapsed');
  if (!host) return;
  const months = btn.dataset.lapsedMonths;
  const masterId = btn.dataset.lapsedMaster || '';
  const title = masterId ? P('analytics.lapsedTitle', { name: btn.dataset.lapsedTitle }) : 'Не вернулись';
  host.hidden = false;
  host.innerHTML = SKELETON;
  host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    const path = `/analytics/lapsed?months=${encodeURIComponent(months)}${masterId ? `&masterId=${encodeURIComponent(masterId)}` : ''}`;
    host.innerHTML = lapsedListHtml(await loadCached(path), title);
    wireMessengerLinks(host);
  } catch (e) {
    host.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(e))}</p>`;
  }
}

async function paint(host, path, render, periodLabel) {
  const node = document.getElementById(host);
  if (!node) return;
  node.innerHTML = SKELETON;
  try {
    const data = await loadCached(path);
    node.innerHTML = render(data, periodLabel);
  } catch (e) {
    // Сообщение об ошибке - на месте цифр, не тостом поверх: владелец должен видеть,
    // что показатель НЕ показан, а не думать, что ноль это факт
    node.innerHTML = `<p class="payroll-note">${escapeHtml(errorMessage(e))}</p>`;
  }
}

function paintRetention(period) {
  return paint(period.host, `/analytics/retention?months=${period.months}`, retentionHtml, period.label);
}

function paintSources(period) {
  return paint(period.host, `/analytics/sources?months=${period.months}`, sourcesHtml, period.label);
}

function paintDiscussed(period) {
  return paint(period.host, `/analytics/renew-discussed?months=${period.months}`, discussedHtml, period.label);
}

// Панель периода, которая сейчас выбрана. Радио живут в вёрстке и переключают панели
// сами, средствами CSS - JS только догружает данные того периода, который человек
// действительно открыл
function checkedPeriod(periods) {
  return periods.find((p) => document.getElementById(p.radio)?.checked) ?? periods[0];
}

let sectionLoaded = false;

export async function renderAnalytics() {
  const jobs = [];
  const ret = checkedPeriod(RETENTION_PERIODS);
  const src = checkedPeriod(SOURCE_PERIODS);
  const disc = checkedPeriod(DISCUSSED_PERIODS);
  if (document.getElementById(ret.host)) jobs.push(paintRetention(ret));
  if (document.getElementById(src.host)) jobs.push(paintSources(src));
  if (document.getElementById(disc.host)) jobs.push(paintDiscussed(disc));
  await Promise.all(jobs);
}

// Мягкое обновление кабинета (Окно 45): цифры перечитываются, кэш периодов сбрасываем
// - иначе кнопка «обновить» показывала бы то же самое из памяти вкладки
export async function refreshAnalytics() {
  if (!sectionLoaded) return; // раздел ни разу не открывали - и обновлять нечего
  cache.clear();
  await renderAnalytics();
}

export function wireAnalytics() {
  if (!document.getElementById(RETENTION_PERIODS[0].host)) return; // страница без раздела

  for (const period of RETENTION_PERIODS) {
    document.getElementById(period.radio)?.addEventListener('change', () => paintRetention(period));
  }
  for (const period of SOURCE_PERIODS) {
    document.getElementById(period.radio)?.addEventListener('change', () => paintSources(period));
  }
  for (const period of DISCUSSED_PERIODS) {
    document.getElementById(period.radio)?.addEventListener('change', () => paintDiscussed(period));
  }

  // Клики по кнопке «N не вернулись», по имени в списке и по «Скрыть» - одним
  // делегированным обработчиком на панель: карточки перерисовываются при каждой смене
  // периода, и вешать обработчики на каждую кнопку заново значило бы их задваивать
  const panel = document.querySelector('.tab-panel.panel-d');
  panel?.addEventListener('click', (e) => {
    const lapsedBtn = e.target.closest('[data-lapsed-months]');
    if (lapsedBtn) return void openLapsed(lapsedBtn);
    const nameBtn = e.target.closest('.an-lapsed-name');
    if (nameBtn) return void goToClient(nameBtn.dataset.clientPhone || '');
    if (e.target.closest('#anLapsedClose')) {
      const host = document.getElementById('anLapsed');
      if (host) { host.hidden = true; host.innerHTML = ''; }
    }
  });

  // Данные тянем в момент первого захода в раздел, а не при загрузке страницы - тот
  // же приём, что у «Клиентов» и «Расписания» (crm:section, assets/crm-app-shell.js)
  document.addEventListener('crm:section', (e) => {
    if (e.detail?.section !== 'analytics' || sectionLoaded) return;
    sectionLoaded = true;
    renderAnalytics();
  });
}
