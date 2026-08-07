// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Контрол статуса брони: радио
// Ожидание/Пришёл/Не пришёл (crm-owner.html, Окно 36) + кнопка "Клиент не пришёл"
// (crm-admin.html/crm-master.html, старее Окна 36 и им не заменённая). Код
// перенесён 1в1, поведение не менялось.
import { API, getToken } from './crm-auth.js';

// mockup-crm.js - классический (не module) скрипт, но браузер делит один и тот же
// глобальный объект между ним и этим модулем, поэтому updateNoShowUi() (объявлена
// там) видна отсюда через window. Правка этого переноса (без изменения поведения):
// было голым идентификатором updateNoShowUi() - тот же рантайм-эффект (JS резолвит
// голый идентификатор через global scope точно так же), но теперь связь с
// mockup-crm.js видна в тексте кода явно, не неявно.

// Окно 36 (06.08.2026) - crm-owner.html СПЕЦИФИЧНО (промпт окна: "другие роли это
// окно не касается"). ВАЖНО: crm-admin.html и crm-master.html имеют СВОИ собственные
// радио с теми же id (bstatus/st-wait/st-came/st-no) и СВОЮ кнопку "Клиент не пришёл"
// (toggleNoShow ниже) - этот код их не касается и не должен. Owner-only гейт - через
// #bk-status-note, элемент существует ТОЛЬКО в crm-owner.html (добавлен этим же
// окном); без него функция no-op, тот же паттерн, что у wireMasterSelfView
// (crm-master-self.js).
//
// Аудит (PRODUCT_AUDIT_REPORT.md, разд. "Владелец") нашёл, что на owner-странице
// радио "Ожидание/Пришёл/Не пришёл" и кнопка toggleNoShow делали одно и то же (один
// и тот же PATCH /bookings/:id/status) через два визуально похожих, но разных
// контрола - владелец не мог на глаз отличить рабочий от декоративного. Радио и
// раньше честно ОТОБРАЖАЛО реальный статус (assets/crm-calendar.js, STATUS_TO_DATA),
// просто клик по нему никуда не отправлялся. На owner-странице радио теперь
// единственный контрол статуса (кнопка убрана из crm-owner.html), и он полнее
// прежней кнопки (все 3 статуса из схемы, не только planned/no_show).
const RADIO_ID_TO_STATUS = { 'st-wait': 'planned', 'st-came': 'done', 'st-no': 'no_show' };
export function wireBookingStatusRadios() {
  if (!document.getElementById('bk-status-note')) return; // не owner-страница - no-op
  const radios = document.querySelectorAll('input[name="bstatus"]');
  radios.forEach((radio) => {
    if (radio.dataset.wired) return;
    radio.dataset.wired = '1';
    radio.addEventListener('change', async () => {
      const panel = document.getElementById('bd-1');
      const bookingId = panel?.dataset.bookingId;
      const note = document.getElementById('bk-status-note');
      if (note) note.hidden = true;
      const prevStatus = panel?.dataset.realStatus || 'planned';
      const nextStatus = RADIO_ID_TO_STATUS[radio.id];
      if (!panel || !bookingId) return; // пример-заглушка без реальной брони, см. openBooking

      document.querySelectorAll('input[name="bstatus"]').forEach((r) => (r.disabled = true));
      try {
        const res = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ status: nextStatus }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        panel.dataset.realStatus = nextStatus;
        // Сервер уже применил счётчик неявок (see server.mjs, /bookings/:id/status) -
        // зеркалим ТОЧНО ТУ ЖЕ if/else-if очерёдность локально, чтобы баннер обновился
        // без перезагрузки страницы (несовпадающий порядок дал бы неверную цифру на
        // переходах вроде no_show → done).
        const prevStreak = parseInt(panel.dataset.noshowStreak, 10) || 0;
        let streak = prevStreak;
        if (nextStatus === 'no_show' && prevStatus !== 'no_show') {
          streak = prevStreak + 1;
        } else if (nextStatus === 'planned' && prevStatus === 'no_show') {
          streak = Math.max(prevStreak - 1, 0);
        } else if (nextStatus === 'done') {
          streak = 0;
        }
        panel.dataset.noshowStreak = String(streak);
        if (typeof window.updateNoShowUi === 'function') window.updateNoShowUi();
      } catch (err) {
        const prevRadioId = Object.keys(RADIO_ID_TO_STATUS).find((id) => RADIO_ID_TO_STATUS[id] === prevStatus);
        const prevRadio = prevRadioId && document.getElementById(prevRadioId);
        if (prevRadio) prevRadio.checked = true;
        if (note) {
          note.hidden = false;
          note.textContent = `Не удалось сохранить: ${err.message}`;
        }
      } finally {
        document.querySelectorAll('input[name="bstatus"]').forEach((r) => (r.disabled = false));
      }
    });
  });
}

// Правка 03.08.2026: кнопка "Клиент не пришёл" в bd-1 (assets/mockup-crm.js,
// onclick="toggleNoShow(this)") - раньше это была декоративная "Фактическое время
// прихода", ничего не сохранявшая. Реально переключает статус брони через уже
// существующий PATCH /bookings/:id/status ('no_show' инкрементирует
// clients.no_show_streak на сервере, обратный клик - откатывает, см. server.mjs).
// ВАЖНО (Окно 36, 06.08.2026): эта кнопка убрана из crm-owner.html (заменена
// радио выше), но живёт в crm-admin.html/crm-master.html - окно 36 их не касалось,
// функция здесь остаётся нетронутой ради этих двух страниц. Остаётся глобальной
// (window.toggleNoShow, не export) - вызывается из inline onclick="toggleNoShow(this)"
// в статичной разметке mockup-crm.js, тот же платформенный HTML-atrribut-scope
// ограничение, что у виджетов даты/времени (см. crm-widgets.js).
window.toggleNoShow = async function toggleNoShow(btn) {
  const panel = document.getElementById('bd-1');
  const bookingId = panel?.dataset.bookingId;
  const note = document.getElementById('bk-noshow-note');
  if (note) note.hidden = true;
  if (!panel || !bookingId) return;

  const wasNoShow = panel.dataset.realStatus === 'no_show';
  const nextStatus = wasNoShow ? 'planned' : 'no_show';
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    panel.dataset.realStatus = nextStatus;
    // Сервер уже применил инкремент/декремент no_show_streak - отражаем ту же
    // арифметику локально, чтобы баннер обновился без перезагрузки страницы.
    const prevStreak = parseInt(panel.dataset.noshowStreak, 10) || 0;
    panel.dataset.noshowStreak = String(wasNoShow ? Math.max(prevStreak - 1, 0) : prevStreak + 1);
    if (typeof window.updateNoShowUi === 'function') window.updateNoShowUi();
  } catch (err) {
    if (note) {
      note.hidden = false;
      note.textContent = `Не удалось сохранить: ${err.message}`;
    }
  } finally {
    btn.disabled = false;
  }
};
