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

function statCard({ label, value, note, lead = false }) {
  return `<div class="stat-card${lead ? ' stat-card--net' : ''}">
    <div class="sc-label">${escapeHtml(label)}</div>
    <div class="sc-value">${escapeHtml(value)}</div>
    ${note ? `<div class="sc-note">${escapeHtml(note)}</div>` : ''}
  </div>`;
}

// ── Возвращаемость ──────────────────────────────────────────────────────────
export function retentionHtml(data, periodLabel) {
  const { salon, masters = [], unlinkedVisits = 0 } = data;
  if (!salon || salon.clients === 0) {
    return `<p class="payroll-note">За этот период (${escapeHtml(periodLabel)}) состоявшихся визитов с записанным клиентом не было - считать возвращаемость не из чего</p>`;
  }

  const salonCard = statCard({
    lead: true,
    label: 'Вернулись повторно, весь салон',
    value: pctText(salon.pct),
    note: `${salon.returned} из ${salon.clients} ${plural(salon.clients, 'клиента', 'клиентов', 'клиентов')} приходили ${periodLabel} больше одного раза`,
  });

  // По сотруднику клиент считается вернувшимся, если пришёл к НЕМУ повторно - иначе
  // цифра мастера мерила бы лояльность салона, а не его личную работу. Сумма по
  // мастерам поэтому не обязана сходиться с цифрой салона, и это сказано словами,
  // а не оставлено владельцу на догадки
  const masterCards = masters.length
    ? masters
        .map((m) =>
          statCard({
            label: m.employed ? m.name : `${m.name} (не работает)`,
            value: pctText(m.pct),
            note:
              m.clients === 0
                ? 'Нет состоявшихся визитов за период'
                : `${m.returned} из ${m.clients} ${plural(m.clients, 'клиента', 'клиентов', 'клиентов')} вернулись к нему снова`,
          })
        )
        .join('')
    : '';

  return `
    <div class="stat-cards">${salonCard}</div>
    <p class="payroll-note">Ниже - тот же показатель по каждому сотруднику: доля его клиентов, которые пришли к нему ещё раз ${escapeHtml(periodLabel)}. Сумма по сотрудникам не равна цифре салона: клиент, сходивший к двум мастерам по разу, для салона вернулся, а для каждого из них - нет</p>
    ${masterCards ? `<div class="stat-cards">${masterCards}</div>` : '<p class="payroll-note">В салоне пока нет сотрудников, оказывающих услуги</p>'}
    ${unlinkedVisits > 0 ? `<p class="payroll-note">Не учтено ${escapeHtml(unlinkedVisits)} ${plural(unlinkedVisits, 'визит', 'визита', 'визитов')} без телефона клиента: такие визиты система намеренно не связывает между собой, вернулся человек или нет - ей неизвестно</p>` : ''}
  `;
}

// ── Как приходят клиенты ────────────────────────────────────────────────────
export function sourcesHtml(data, periodLabel) {
  const { total = 0, rows = [] } = data;
  if (total === 0) {
    return `<p class="payroll-note">За этот период (${escapeHtml(periodLabel)}) записей не было</p>`;
  }

  const cards = rows
    .map((row) =>
      statCard({
        // key === null - записи, у которых источник не проставлен. Это не канал и
        // подписан он честно: клиент мог прийти по звонку, а мог просто остаться
        // незаполненным в карточке
        label: row.key ? CLIENT_SOURCE_LABELS[row.key] ?? row.key : 'Источник не указан',
        value: pctText(row.pct),
        note: `${row.count} ${plural(row.count, 'запись', 'записи', 'записей')}`,
      })
    )
    .join('');

  return `
    <div class="stat-cards">${cards}</div>
    <p class="payroll-note">Всего записей ${escapeHtml(periodLabel)}: ${escapeHtml(total)}. Источник берётся с самой записи: с сайта он определяется по ссылке, по которой человек пришёл (карточка организации в Яндекс Картах, 2ГИС, соцсети), в салоне его проставляет администратор в поле «Откуда клиент»</p>
  `;
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
  if (document.getElementById(ret.host)) jobs.push(paintRetention(ret));
  if (document.getElementById(src.host)) jobs.push(paintSources(src));
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

  // Данные тянем в момент первого захода в раздел, а не при загрузке страницы - тот
  // же приём, что у «Клиентов» и «Расписания» (crm:section, assets/crm-app-shell.js)
  document.addEventListener('crm:section', (e) => {
    if (e.detail?.section !== 'analytics' || sectionLoaded) return;
    sectionLoaded = true;
    renderAnalytics();
  });
}
