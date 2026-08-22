// Поле «когда клиенту прийти снова» в форме записи (Окно 59, 22.08.2026).
//
// Место выбрано принципиально: не карточка клиента, а момент, когда визит отмечают
// состоявшимся. Разговор про срок происходит в конце стрижки, и поле, спрятанное в
// карточке клиента, не заполнил бы никто.
//
// Поле обязательное - но обязательность держит СЕРВЕР (PATCH /bookings/:id/status
// отвечает renew_required), а не эта разметка: спрятать блок в вёрстке и закрыть визит
// мимо него не выйдет. Здесь только удобство ввода и подсказка мастеру.
//
// Правила, которые видно прямо в поведении контролов:
//   - «Не обсуждали» ставит месяц и гасит ввод срока. Это законный, не наказуемый
//     выбор: интерфейс не подсвечивает его ошибкой и ничего не требует дописать;
//   - срок, который мастер считает правильным, спрашивается ТОЛЬКО когда согласованный
//     от него отличается (причины «особенность волос», «дорого», «график»). Если
//     клиент согласился с названным сроком - правильный и согласованный это одно и то
//     же число, спрашивать его второй раз незачем;
//   - у постоянного клиента поле приходит уже заполненным прошлой договорённостью.
//     Допрашивать его каждый визит нельзя - мастер начнёт штамповать что попало.
import { RENEW_REASON_LABELS, RENEW_HINT_LINES } from './renew-reason.js';

const DEFAULT_DAYS = 30;
// Быстрые кнопки - в неделях, потому что мастер думает и говорит неделями («держит
// форму три недели»), а не в днях
const QUICK_WEEKS = [2, 3, 4, 6, 8];

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// «28 дней» человек читает хуже, чем «4 недели». Показываем недели, когда срок ровно
// в них укладывается, иначе честно дни - подгонять цифру под красивую подпись нельзя
export function daysLabel(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n % 7 === 0) {
    const weeks = n / 7;
    const word = weeks === 1 ? 'неделя' : weeks >= 2 && weeks <= 4 ? 'недели' : 'недель';
    return `${weeks} ${word}`;
  }
  const word = n % 10 === 1 && n % 100 !== 11 ? 'день' : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14) ? 'дня' : 'дней';
  return `${n} ${word}`;
}

// Причина, при которой согласованный срок по смыслу отличается от правильного - тогда
// и только тогда спрашиваем второй срок
function reasonNeedsRecommended(reason) {
  return reason === 'hair' || reason === 'price' || reason === 'schedule';
}

export function renewQuickButtonsHtml() {
  return QUICK_WEEKS.map(
    (w) => `<button type="button" class="renew-quick" data-renew-days="${w * 7}">${w} нед</button>`
  ).join('');
}

export function renewReasonRadiosHtml() {
  return Object.entries(RENEW_REASON_LABELS)
    .map(
      ([key, label]) => `<label class="renew-reason">
        <input type="radio" name="renewReason" value="${escapeHtml(key)}">
        <span>${escapeHtml(label)}</span>
      </label>`
    )
    .join('');
}

export function renewHintHtml() {
  return RENEW_HINT_LINES.map((line) => `<span>${escapeHtml(line)}</span>`).join('');
}

function selectedReason() {
  return document.querySelector('input[name="renewReason"]:checked')?.value ?? null;
}

function syncControls() {
  const reason = selectedReason();
  const daysInput = el('wfRenewDays');
  const recommendedRow = el('wfRenewRecommendedRow');
  const notDiscussed = reason === 'not_discussed';
  if (daysInput) {
    if (notDiscussed) daysInput.value = String(DEFAULT_DAYS);
    daysInput.disabled = notDiscussed;
  }
  if (recommendedRow) recommendedRow.hidden = !reasonNeedsRecommended(reason);
  const summary = el('wfRenewSummary');
  if (summary) {
    const days = Number(daysInput?.value);
    summary.textContent = Number.isFinite(days) && days > 0 ? `Ждём клиента через ${daysLabel(days)}` : '';
  }
}

// Что уедет на сервер вместе со статусом «Обслужен». null - поле не заполнено:
// сервер в этом случае либо оставит прежнюю договорённость клиента, либо откажет
// с renew_required, если её никогда не было. Решает он, не мы.
export function renewFieldPayload() {
  const reason = selectedReason();
  if (!reason) return null;
  const daysRaw = Number(el('wfRenewDays')?.value);
  const days = reason === 'not_discussed' ? DEFAULT_DAYS : daysRaw;
  if (!Number.isFinite(days) || days <= 0) return null;
  const recommendedRaw = Number(el('wfRenewRecommended')?.value);
  // При «клиент согласился» правильный срок и есть согласованный - второго поля в
  // интерфейсе нет, и подставлять сюда пусто было бы потерей факта
  const recommendedDays = reasonNeedsRecommended(reason)
    ? Number.isFinite(recommendedRaw) && recommendedRaw > 0 ? Math.round(recommendedRaw) : null
    : reason === 'recommended' ? Math.round(days) : null;
  return {
    days: Math.round(days),
    recommendedDays,
    reason,
    note: (el('wfRenewNote')?.value ?? '').trim() || null,
  };
}

// Строка для снимка формы (editBaseline в assets/crm-walkin.js): кнопка «Сохранить
// изменения» должна оживать, когда мастер поменял срок, и гаснуть после сохранения
export function renewFieldSnapshot() {
  const payload = renewFieldPayload();
  return payload ? `${payload.days}|${payload.recommendedDays ?? ''}|${payload.reason}|${payload.note ?? ''}` : '';
}

// Подстановка договорённости с прошлого визита. Пусто - поле остаётся пустым, и
// «месяц по умолчанию» само собой не появляется: месяц ставится только осознанным
// выбором «не обсуждали», иначе метрика обсуждённых сроков врала бы в пользу салона.
export function setRenewPrefill(renew) {
  const days = Number(renew?.days);
  const daysInput = el('wfRenewDays');
  if (daysInput) daysInput.value = Number.isFinite(days) && days > 0 ? String(days) : '';
  const recommended = Number(renew?.recommendedDays);
  const recommendedInput = el('wfRenewRecommended');
  if (recommendedInput) recommendedInput.value = Number.isFinite(recommended) && recommended > 0 ? String(recommended) : '';
  const note = el('wfRenewNote');
  if (note) note.value = renew?.note ?? '';
  document.querySelectorAll('input[name="renewReason"]').forEach((radio) => {
    radio.checked = !!renew?.reason && radio.value === renew.reason;
  });
  const setBy = el('wfRenewSetBy');
  if (setBy) {
    const when = renew?.setAt ? String(renew.setAt).slice(0, 10).split('-').reverse().join('.') : '';
    setBy.textContent = renew?.setByName && when ? `Срок поставил ${renew.setByName}, ${when}` : '';
    setBy.hidden = !setBy.textContent;
  }
  syncControls();
}

// Блок виден только там, где вопрос имеет смысл: визит отмечают состоявшимся И у него
// есть клиент с телефоном. У walk-in без телефона система намеренно не связывает визиты
// между собой - напоминать некому, и спрашивать не о чем.
export function setRenewVisible(visible) {
  const host = el('wfRenew');
  if (host) host.hidden = !visible;
}

export function isRenewVisible() {
  const host = el('wfRenew');
  return !!host && !host.hidden;
}

export function wireRenewField(onChange) {
  const host = el('wfRenew');
  if (!host || host.dataset.wired) return;
  host.dataset.wired = '1';

  const quick = el('wfRenewQuick');
  if (quick) quick.innerHTML = renewQuickButtonsHtml();
  const reasons = el('wfRenewReasons');
  if (reasons) reasons.innerHTML = renewReasonRadiosHtml();
  const hint = el('wfRenewHint');
  if (hint) hint.innerHTML = renewHintHtml();

  host.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-renew-days]');
    if (!btn) return;
    const daysInput = el('wfRenewDays');
    if (!daysInput || daysInput.disabled) return;
    daysInput.value = btn.dataset.renewDays;
    syncControls();
    onChange?.();
  });
  host.addEventListener('change', (e) => {
    if (e.target?.name === 'renewReason') syncControls();
    onChange?.();
  });
  host.addEventListener('input', () => {
    syncControls();
    onChange?.();
  });
}
