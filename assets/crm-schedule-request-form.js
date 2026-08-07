// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Форма "Разовое изменение на дату"
// (сторона мастера, crm-master.html) - POST /schedule-requests, владелец
// подтверждает/отклоняет отдельно. Код перенесён 1в1, поведение не менялось.
import { el, todayStr } from './crm-shared.js';
import { renderDateSelect, renderTimeSelect, timeSelectValue, dateSelectValue } from './crm-widgets.js';
import { API, getToken, fetchJson } from './crm-auth.js';
import { WEEKDAY_SHORT } from './crm-schedule-editor.js';

// Форма "Разовое изменение на дату" (Задача 3, Окно 14, заголовок переименован
// Окно 16 03.08.2026 - было "Запросить перерыв/выходной") - POST /schedule-requests,
// владелец подтверждает/отклоняет отдельно (PATCH .../decision), время реально
// блокируется от онлайн-записи только после подтверждения. Только otgul/otpusk -
// механика не менялась (Окно 16, разд.31 промпта); постоянный график по дням
// недели теперь read-only, см. renderWeeklySelfReadOnly (crm-schedule-editor.js, Окно 19).
const SCHEDULE_CATEGORY_LABEL = {
  otgul: 'Отгул разовый',
  otpusk: 'Отпуск',
};

// "Мои запросы" - общая история для обеих форм (разовое изменение otgul/otpusk И
// постоянный график grafik_standard) - один и тот же список #reqHistory на
// странице, обе формы после отправки перезагружают его этой функцией.
export async function loadScheduleRequestHistory(staffId) {
  const historyEl = el('reqHistory');
  if (!historyEl) return;
  try {
    const rows = await fetchJson(`/schedule-requests?masterId=${staffId}`);
    if (!rows.length) {
      historyEl.innerHTML = '<span class="note">Запросов пока нет</span>';
      return;
    }
    // cancelled добавлен Окном 23 (04.08.2026) - владелец может отменить уже одобренный
    // отгул/отпуск целиком (PATCH /schedule-requests/:id/cancel). Без этой строки фолбэк
    // `?? r.status` показывал бы мастеру сырое "cancelled" латиницей в русском интерфейсе.
    const statusLabel = { pending: 'На рассмотрении', approved: 'Одобрено', rejected: 'Отклонено', cancelled: 'Одобрение отменено' };
    historyEl.innerHTML = rows
      .map((r) => {
        if (r.category === 'grafik_standard') {
          return `<div class="break-row"><span class="note">Новый график · ${formatWeeklyChangesSummary(r.weeklyChanges || [])} · ${statusLabel[r.status] ?? r.status}${r.ownerComment ? ' · ' + r.ownerComment : ''}</span></div>`;
        }
        const period = r.requestType === 'day_off' ? `${r.dateFrom}–${r.dateTo}` : `${r.dateFrom} ${r.startTime}–${r.endTime}`;
        const label = SCHEDULE_CATEGORY_LABEL[r.category] ?? (r.requestType === 'day_off' ? 'Выходной' : 'Перерыв');
        return `<div class="break-row"><span class="note">${label} · ${period} · ${statusLabel[r.status] ?? r.status}${r.ownerComment ? ' · ' + r.ownerComment : ''}</span></div>`;
      })
      .join('');
  } catch (err) {
    historyEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
  }
}
export function formatWeeklyChangesSummary(rows) {
  return [...rows]
    .sort((a, b) => a.weekday - b.weekday)
    .map((r) => {
      if (!r.isWorking) return `${WEEKDAY_SHORT[r.weekday - 1]} выходной`;
      const brk = r.breakStart ? ` (перерыв ${r.breakStart}–${r.breakEnd})` : '';
      return `${WEEKDAY_SHORT[r.weekday - 1]} ${r.workStart}–${r.workEnd}${brk}`;
    })
    .join(', ');
}

export function wireScheduleRequestForm(staff) {
  const submitBtn = el('reqSubmitBtn');
  const categoryEl = el('reqCategory');
  const dateToWrap = el('reqDateToWrap');
  const fullDayWrap = el('reqFullDayWrap');
  const fullDayEl = el('reqFullDay');
  const timeFields = el('reqTimeFields');
  const commentEl = el('reqComment');
  const resultEl = el('reqResult');
  if (!submitBtn || !categoryEl || !commentEl || !resultEl) return;

  renderDateSelect('reqDateFrom-slot', 'reqDateFrom', todayStr());
  renderDateSelect('reqDateTo-slot', 'reqDateTo', todayStr());
  renderTimeSelect('reqStartTime-slot', 'reqStartTime', '13:00');
  renderTimeSelect('reqEndTime-slot', 'reqEndTime', '14:00');

  const syncFields = () => {
    const isOtgul = categoryEl.value === 'otgul';
    const isOtpusk = categoryEl.value === 'otpusk';
    const fullDayOff = isOtgul && fullDayEl?.checked;
    if (fullDayWrap) fullDayWrap.style.display = isOtgul ? '' : 'none';
    if (dateToWrap) dateToWrap.style.display = fullDayOff ? 'none' : '';
    // Отпуск - структурно всегда day_off (см. requestType ниже), поля времени
    // для него не должны показываться никогда, не только когда включён "На весь
    // день" (баг Окна 19: раньше показывались всегда, category==='otgul' в условии
    // требования короткого замыкания давал isOtgul=false для otpusk).
    if (timeFields) timeFields.style.display = fullDayOff || isOtpusk ? 'none' : '';
  };
  syncFields();
  categoryEl.addEventListener('change', syncFields);
  fullDayEl?.addEventListener('change', syncFields);

  loadScheduleRequestHistory(staff.id);

  if (submitBtn.dataset.wired) return;
  submitBtn.dataset.wired = '1';
  submitBtn.addEventListener('click', async () => {
    const category = categoryEl.value;
    const dateFrom = dateSelectValue('reqDateFrom');
    if (!dateFrom) {
      resultEl.textContent = 'Укажите дату';
      return;
    }
    // Баг Окна 19 (найден 04.08.2026): было `category === 'otgul' && fullDayEl?.checked` -
    // короткое замыкание на 'otgul' делало это условие ВСЕГДА ложным для 'otpusk',
    // отпуск уходил на сервер как requestType:'break' с конкретным временем (13:00-14:00
    // по умолчанию) вместо day_off на весь диапазон дат. Отпуск структурно не может
    // быть "на два часа" - всегда day_off, независимо от чекбокса "На весь день"
    // (который вообще не показывается для этой категории, см. syncFields выше).
    const requestType = category === 'otpusk' || (category === 'otgul' && fullDayEl?.checked) ? 'day_off' : 'break';
    const startTime = requestType === 'break' ? timeSelectValue('reqStartTime') : null;
    const endTime = requestType === 'break' ? timeSelectValue('reqEndTime') : null;
    if (requestType === 'break' && (!startTime || !endTime)) {
      resultEl.textContent = 'Укажите время (с и до)';
      return;
    }
    try {
      const res = await fetch(`${API}/schedule-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({
          category,
          requestType,
          dateFrom,
          dateTo: dateSelectValue('reqDateTo') || dateFrom,
          startTime,
          endTime,
          masterComment: commentEl.value.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(`schedule-requests → ${res.status}`);
      resultEl.textContent = 'Запрос отправлен, владелец увидит уведомление';
      commentEl.value = '';
      loadScheduleRequestHistory(staff.id);
    } catch (err) {
      resultEl.textContent = `Не удалось отправить: ${err.message}`;
    }
  });
}
