// Карточки "Зарплаты мастеров" в разделе "Финансы" владельца - разметка и связка
// элементов. Правка Влада 21.08.2026: до неё в crm-owner.html лежали три
// захардкоженных набора (Алиовсад/Мамедхан/Елизавета, id zp1*/zp2*/zp3*), поэтому
// четвёртый сотрудник в "Финансы" просто не попадал, сколько бы тумблеров "Принимает
// клиентов" ему ни включили. Здесь карточка строится на КАЖДОГО, кто оказывает
// услуги, по факту ответа /staff.
//
// Переключатель периода - кнопки, а не radio + правило
// "#id:checked ~ .panel-id" в <style> страницы: та схема требует одно CSS-правило на
// каждый id и несовместима с неизвестным заранее числом карточек (та же причина и то
// же решение, что у buildMasterSwitch в assets/crm-schedule-shared.js).
//
// Считает суммы не этот файл, а assets/crm-payroll.js - здесь только DOM.
import { avatarMarkup, avatarUrlOf } from './crm-avatar.js';
import { renderDateSelect } from './crm-widgets.js';
import { defaultPctFor, firedLabel, isEmployed, payrollStaff, todayStr } from './crm-shared.js';

const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const roleLabel = { owner: 'Владелец', manager: 'Управляющий', admin: 'Администратор', master: 'Мастер' };

// Правила «кто попадает в блок» и «какая ставка по умолчанию» живут в crm-shared.js:
// их читает и расчёт в crm-dashboard.js, дублировать нельзя - разъедутся

const PERIODS = [
  { key: 'day', label: 'За день' },
  { key: 'week', label: 'За неделю', note: 'За неделю - с понедельника по сегодня' },
  { key: 'month', label: 'За месяц', note: 'За месяц - с 1 числа по сегодня' },
  { key: 'period', label: 'Задать период' },
];

function periodPanelMarkup(period) {
  const note = period.note ? `<p class="payroll-note">${period.note}</p>` : '';
  if (period.key !== 'period') {
    return `<div class="payroll-period-panel" data-period-panel="${period.key}" hidden>
      <div class="payroll-sum"><span class="amount" data-amount="${period.key}">000 ₽ <span class="unsure">считаю…</span></span></div>${note}
    </div>`;
  }
  return `<div class="payroll-period-panel" data-period-panel="period" hidden>
      <div class="payroll-period-picker">
        <div class="field"><label>С</label><div class="payroll-date-slot"></div></div>
        <div class="field"><label>По</label><div class="payroll-date-slot"></div></div>
        <button class="btn btn-ghost btn-sm" type="button" data-period-show>Показать</button>
      </div>
      <div class="payroll-sum"><span class="amount" data-amount="period">—</span></div>
    </div>`;
}

function cardMarkup(staff, pct, pctIsSet) {
  // Карточка уволенного (22.08.2026) - это отчёт по закрытому периоду, а не рабочее
  // место: ставку менять нечему, поэтому поле только для чтения и кнопки сохранения
  // нет. Суммы за прошлые периоды считаются ровно той же формулой, что и у всех
  const fired = !isEmployed(staff);
  const hint = fired
    ? `<p class="payroll-note" data-pct-note>${esc(firedLabel(staff))}. Ставку уволенному не меняем - суммы показаны по той, что действовала</p>`
    : (pctIsSet ? '' : '<p class="payroll-note" data-pct-note>Ставка ещё не задана - впишите процент и сохраните</p>');
  const roleLine = fired
    ? `${esc(roleLabel[staff.role] ?? staff.role)} · ${esc(firedLabel(staff))}`
    : esc(roleLabel[staff.role] ?? staff.role);
  return `<details class="staff-card payroll-card${fired ? ' payroll-card-fired' : ''}" data-master-id="${esc(staff.id)}"${fired ? ' data-fired="1"' : ''}>
    <summary>${avatarMarkup(staff)}<div class="summary-meta"><div class="name">${esc(staff.name)}</div><div class="role">${roleLine}</div></div><span class="chevron">▸</span></summary>
    <div class="staff-card-body">
      <div class="field-grid">
        <div class="field"><label>Ставка от выручки, %</label><input type="number" min="0" max="100" step="1" inputmode="numeric" data-pct-input value="${esc(pct)}"${fired ? ' disabled' : ''}></div>
      </div>
      ${fired ? '' : '<button class="btn btn-ghost btn-sm" type="button" data-pct-save>Сохранить ставку</button>'}
      ${hint || '<p class="payroll-note" data-pct-note></p>'}
      <div class="master-switch-row">
        <div class="seg-bar payroll-period-row">
          ${PERIODS.map((p, i) => `<button type="button" class="payroll-period-pill${i === 0 ? ' active' : ''}" data-period="${p.key}">${p.label}</button>`).join('')}
        </div>
      </div>
      ${PERIODS.map(periodPanelMarkup).join('')}
    </div>
  </details>`;
}

function wirePeriodSwitch(card) {
  const panels = [...card.querySelectorAll('[data-period-panel]')];
  const buttons = [...card.querySelectorAll('.payroll-period-pill[data-period]')];
  const show = (key) => {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.period === key));
    panels.forEach((p) => {
      p.hidden = p.dataset.periodPanel !== key;
    });
  };
  buttons.forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.period)));
  show(PERIODS[0].key);
}

// Виджеты дат в "Задать период" - те же .payroll-date-slot, что и раньше. Раньше
// слоты нумеровались сквозным индексом по всей странице (wirePayrollDateSlots), а
// карточки теперь появляются и исчезают вместе с составом команды, поэтому индекс
// брать неоткуда - идёт свой счётчик, который просто не повторяется за сессию.
// id мастера в него НЕ подставляем: buildDateWidgetHtml вставляет этот id в разметку
// без экранирования (assets/crm-widgets.js), и хотя id сотрудника генерит сервер
// (`staff-<hex>`), значение из базы в сырой HTML-атрибут пускать незачем.
// Само значение читается позиционно, через .custom-date внутри панели - id нужен
// только чтобы быть уникальным
let dateSlotSeq = 0;
function wireDateSlots(card) {
  card.querySelectorAll('.payroll-date-slot').forEach((slot) => {
    if (slot.dataset.wired) return;
    slot.dataset.wired = '1';
    renderDateSelect(slot, `payrollDate-${++dateSlotSeq}`, todayStr());
  });
}

// Перестраивает список карточек, если состав изменился, и возвращает узлы карточек в
// том же порядке, что и staff. Уже стоящие карточки не пересоздаются: иначе раскрытый
// <details>, выбранный период и введённые даты сбрасывались бы на каждом обновлении
// данных (кнопка "Обновить данные" в шапке дёргает refreshFinance).
export function renderPayrollCards(host, staffList, pctByMaster, mastersWithPaidVisits) {
  if (!host) return [];
  const staff = payrollStaff(staffList, mastersWithPaidVisits);
  // В подпись входит не только состав, но имя, роль и фото: переименовали сотрудника
  // или он загрузил аватар - карточку надо перерисовать, иначе в "Финансах" останется
  // старое имя до перезагрузки страницы
  const signature = staff.map((s) => `${s.id}|${s.name}|${s.role}|${s.employed === false ? `fired:${s.employmentEndedAt ?? ''}` : 'active'}|${avatarUrlOf(s) ?? ''}`).join(',');
  if (host.dataset.signature !== signature) {
    host.dataset.signature = signature;
    host.innerHTML = staff.length
      ? staff.map((s) => cardMarkup(s, pctByMaster.get(s.id) ?? defaultPctFor(s), pctByMaster.has(s.id))).join('')
      : '<p class="payroll-note">Пока никто из сотрудников не принимает клиентов - включите "Принимает клиентов" в разделе "Сотрудники"</p>';
    host.querySelectorAll('.payroll-card').forEach((card) => {
      wirePeriodSwitch(card);
      wireDateSlots(card);
    });
  }
  return staff.map((s) => ({ staff: s, card: host.querySelector(`.payroll-card[data-master-id="${CSS.escape(s.id)}"]`) })).filter((r) => r.card);
}

// Ставка могла измениться на сервере между обновлениями (второе окно, другой человек).
// Поле не перетираем, пока в нём стоит фокус - иначе цифра прыгает под руками
export function syncPctInputs(rows, pctByMaster) {
  for (const { staff, card } of rows) {
    const input = card.querySelector('[data-pct-input]');
    if (!input || input === document.activeElement) continue;
    input.value = pctByMaster.get(staff.id) ?? defaultPctFor(staff);
  }
}
