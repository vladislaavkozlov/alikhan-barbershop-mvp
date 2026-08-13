// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Контрол статуса брони: радио
// Ожидание/Пришёл/Не пришёл (crm-owner.html, Окно 36) + кнопка "Клиент не пришёл"
// (crm-admin.html/crm-master.html, старее Окна 36 и им не заменённая). Код
// перенесён 1в1, поведение не менялось.
import { API, getToken } from './crm-auth.js';
import { formatMoney } from './crm-shared.js';

// Окно 55, Задача C (10.08.2026) - носитель id открытой записи. До этого окна им
// всегда была карточка-просмотр #bd-1 (assets/mockup-crm.js openBooking писала туда
// dataset.bookingId). Теперь на crm-owner.html/crm-admin.html запись открывается в
// ОБЩЕЙ форме (#walkinForm, режим edit - assets/crm-walkin.js), и панелью выступает
// она; на crm-master.html формы нет вообще (мастер записи не создаёт и не переносит,
// решение Влада 08.08.2026), там по-прежнему #bd-1. Одна функция вместо пяти прямых
// getElementById('bd-1') - чтобы обе страницы обслуживал один и тот же код, а не две
// копии обработчиков. Форма приоритетнее: пока она открыта в режиме edit, именно её
// dataset описывает запись, с которой работает пользователь.
function bookingPanel() {
  const form = document.getElementById('walkinForm');
  if (form && form.dataset.bookingId) return form;
  return document.getElementById('bd-1');
}

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
      const panel = bookingPanel();
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
  const panel = bookingPanel();
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

// "Добавить услугу к записи" (08.08.2026, жалоба Влада: мастер во время/после визита
// обнаруживает доп. услугу - например, подстригли и уже потом попросили бритьё - а
// внести это было физически некуда, чтобы верно попало в статистику/зарплату). Блок
// "Корректировка услуги" в bd-1 был статичным макетом с 03.08.2026 (см. историю
// pickServiceForBooking выше в mockup-crm.js) - здесь он подключается к реальным
// данным и реальному сохранению (PATCH /bookings/:id/services, api/routes/bookings.js
// handleBookingAddServices). ТОЛЬКО добавление - уже оказанные услуги отмечены и
// заблокированы (не снимаются здесь), это фиксация уже случившегося визита, не
// редактирование задним числом с возможностью что-то убрать.
// Состояние на уровне модуля, не внутри wireBookingServiceEdit() - в DOM всегда
// ровно одна карточка записи (bd-1), а сама функция вызывается заново при каждом
// renderLiveProof() (после сохранения walk-in и т.п., см. crm-dashboard.js). Если
// бы bookingServiceEditSelected жил внутри функции, повторный вызов создавал бы НОВОЕ замыкание
// с новым Set, а обработчик клика на saveBtn (не перепривязывается повторно из-за
// dataset.wired) остался бы читать СТАРЫЙ Set первого вызова - отметка чекбокса
// обновляла бы один Set, кнопка "Сохранить" проверяла бы другой, всегда пустой.
let bookingServiceEditSelected = new Set();

export function wireBookingServiceEdit(services, masterServices) {
  const picker = document.getElementById('bkServiceEditPicker');
  const saveBtn = document.getElementById('bkServiceEditSave');
  const resultEl = document.getElementById('bkServiceEditResult');
  if (!picker || !saveBtn || !resultEl) return; // страница без этого блока - no-op

  const servicesFor = (masterId) =>
    masterServices
      .filter((r) => r.masterId === masterId)
      .map((r) => ({ ...r, name: services.find((s) => s.id === r.serviceId)?.name ?? r.serviceId }));

  window.renderBookingServiceEdit = function renderBookingServiceEdit(masterId, existingServiceIds) {
    bookingServiceEditSelected = new Set();
    resultEl.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохранить услугу';
    picker.innerHTML = '';
    const existing = new Set(existingServiceIds || []);
    const rows = servicesFor(masterId);
    if (rows.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'section-hint';
      hint.textContent = 'У этого мастера пока не назначено ни одной услуги в прайсе';
      picker.appendChild(hint);
      return;
    }
    for (const row of rows) {
      const isExisting = existing.has(row.serviceId);
      const label = document.createElement('label');
      label.className = 'service-check' + (isExisting ? ' service-check--blocked' : '');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = row.serviceId;
      input.checked = isExisting;
      input.disabled = isExisting;
      const span = document.createElement('span');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sc-name';
      nameSpan.textContent = row.name;
      const priceSpan = document.createElement('span');
      priceSpan.className = 'sc-price';
      priceSpan.textContent = formatMoney(row.price);
      span.append(nameSpan, priceSpan);
      label.append(input, span);
      input.addEventListener('change', () => {
        if (input.checked) bookingServiceEditSelected.add(row.serviceId);
        else bookingServiceEditSelected.delete(row.serviceId);
        saveBtn.disabled = bookingServiceEditSelected.size === 0;
      });
      picker.appendChild(label);
    }
  };

  if (!saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.addEventListener('click', async () => {
      const panel = bookingPanel();
      const bookingId = panel?.dataset.bookingId;
      const masterId = panel?.dataset.bookingMasterId;
      if (!bookingId || bookingServiceEditSelected.size === 0) return;
      const originalLabel = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохраняю…';
      resultEl.hidden = true;
      try {
        const res = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/services`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ serviceIds: [...bookingServiceEditSelected] }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
        // renderBookingServiceEdit() САМА сбрасывает resultEl.hidden=true в начале
        // (обычный сценарий - открыли новую запись, старое сообщение не нужно) -
        // поэтому перерисовываем чекбоксы СНАЧАЛА, а текст подтверждения ставим
        // ПОСЛЕ, иначе успешное сохранение молча гасило бы собственное сообщение.
        window.renderBookingServiceEdit(masterId, data.booking.serviceIds);
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--ok';
        resultEl.textContent = 'Услуга добавлена к записи';
      } catch (err) {
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--err';
        resultEl.textContent = `Не удалось сохранить: ${err.message}`;
        saveBtn.textContent = originalLabel;
        saveBtn.disabled = false;
      }
    });
  }
}

// "Удалить запись" (08.08.2026, Влад: "мастер зашёл случайно, сохранил не на ту
// дату - её же можно спокойно удалить?") - НАСТОЯЩЕЕ удаление (DELETE /bookings/:id,
// handleBookingDelete), не отмена статуса: отменённая бронь всё равно считалась бы в
// выручке/зарплате мастера (computeMasterPayroll не смотрит на статус). owner/admin-
// only - #bkDeleteRow есть только в crm-owner.html/crm-admin.html, на crm-master.html
// его нет вообще (мастер записи больше не создаёт и не удаляет, см. правку в этом же
// окне про POST /bookings). Подтверждение - двухшаговая замена кнопки прямо в строке
// (не нативный window.confirm() - конвенция проекта, см. assets/crm-schedule-requests.js
// wireCancelButtons).
export function wireBookingDelete() {
  const row = document.getElementById('bkDeleteRow');
  if (!row) return; // страница без этого блока (crm-master.html) - no-op

  function renderIdle() {
    row.innerHTML = '<button type="button" class="btn btn-danger btn-sm" id="bkDeleteBtn">Удалить запись</button>';
    row.querySelector('#bkDeleteBtn').addEventListener('click', renderConfirm);
  }

  function renderConfirm() {
    row.innerHTML = `<span class="note" style="margin-right:8px">Удалить запись безвозвратно? Из статистики и зарплаты тоже пропадёт</span>
      <button class="btn btn-danger btn-sm" type="button" id="bkDeleteYes">Да, удалить</button>
      <button class="btn btn-ghost btn-sm" type="button" id="bkDeleteNo">Нет</button>`;
    row.querySelector('#bkDeleteYes').addEventListener('click', () => doDelete(false));
    row.querySelector('#bkDeleteNo').addEventListener('click', renderIdle);
  }

  // Правка 08.08.2026 (тот же вечер, явное ТЗ Влада) - отдельный экран именно для
  // случая "к записи привязана продажа", а не общая ошибка "не удалось удалить":
  // сотрудник должен явно увидеть ПОЧЕМУ система переспрашивает (продажа участвует в
  // расчёте ЗП) и осознанно решить, прежде чем подтвердить. saleTotal - сколько денег
  // затронет удаление, не абстрактное "есть какая-то продажа".
  function renderSaleWarning(saleCount, saleTotal) {
    const sumText = Number.isFinite(saleTotal) ? `${formatMoney(saleTotal)}` : `${saleCount} шт.`;
    row.innerHTML = `<span class="note" style="margin-right:8px">К данной записи привязана продажа (${sumText}), которая участвует в расчёте ЗП. Подтверждаете удаление?</span>
      <button class="btn btn-danger btn-sm" type="button" id="bkDeleteForceYes">Подтверждаю</button>
      <button class="btn btn-ghost btn-sm" type="button" id="bkDeleteForceNo">Отмена</button>`;
    row.querySelector('#bkDeleteForceYes').addEventListener('click', () => doDelete(true));
    row.querySelector('#bkDeleteForceNo').addEventListener('click', renderIdle);
  }

  async function doDelete(force) {
    const panel = bookingPanel();
    const bookingId = panel?.dataset.bookingId;
    if (!bookingId) return;
    row.innerHTML = '<span class="note">Удаляю…</span>';
    try {
      const res = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ force }),
      });
      const data = res.status === 204 ? { ok: true } : await res.json();
      if (res.status === 409 && data.reason === 'has_sale' && !force) {
        renderSaleWarning(data.saleCount, data.saleTotal);
        return;
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      // Карточка в календаре помечена .appt--selected самим openBooking() (mockup-
      // crm.js) при открытии - убираем её из DOM напрямую, без полной перезагрузки
      // текущего вида Дня/Недели/Месяца (тот же уровень "не обновляем календарь
      // визуально", что уже есть у смены статуса выше - остаётся так же честно).
      document.querySelector('.appt--selected')?.remove();
      // Окно 55, Задача C - панелью теперь может быть либо <details> (старая карточка
      // #bd-1, crm-master.html), либо <div class="walkin-form"> (общая форма в режиме
      // edit, owner/admin). У div нет .open - ему нужно hidden, иначе после удаления
      // форма осталась бы открытой с id уже несуществующей записи, и следующее
      // нажатие "Сохранить изменения" ушло бы в 404.
      if (panel) {
        if (panel.tagName === 'DETAILS') {
          panel.open = false;
        } else {
          delete panel.dataset.bookingId;
          panel.hidden = true;
        }
      }
      row.innerHTML = '<span class="note">Запись удалена</span>';
    } catch (err) {
      row.innerHTML = `<span class="note" style="color:var(--danger)">Не удалось удалить: ${err.message}</span>`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-ghost btn-sm';
      retry.textContent = 'Ок';
      retry.style.marginLeft = '8px';
      retry.addEventListener('click', renderIdle);
      row.appendChild(retry);
    }
  }

  window.renderBookingDeleteRow = renderIdle;
}

// "Фактическая сумма" (08.08.2026, вечер, Влад: "Али иногда говорит администратору
// 'пробей по старой цене' - скидка клиенту"). Пусто = как по списку услуг (ничего не
// меняется по умолчанию). Влияет на зарплату мастера только если владелец включил
// это отдельной политикой ("Финансы" → "Управление скидками", assets/crm-payroll.js
// wireDiscountSettings) - здесь только сама цифра визита, PATCH
// /bookings/:id/actual-price (handleBookingActualPrice, owner/admin).
// Правка 13.08.2026 (Влад: "почему если отличается? пусть подтягивается сумма услуг,
// а администратор скорректирует, если владелец дал скидку"). Поле больше не пустое:
// сумму выбранных услуг в него кладёт syncBookingActualPrice, которую зовёт
// renderSummary (assets/crm-walkin.js) на каждое изменение состава. Ручная правка
// поднимает priceTouched - после неё автоподстановка молчит, иначе она затирала бы
// только что вписанную скидку при любом пересчёте.
// Модульное состояние, не замыкание внутри wireBookingActualPrice() - функция
// вызывается заново на каждый renderLiveProof(), а обработчик клика привязан к первой
// версии (dataset.wired), см. reference_barbershop-dataset-wired-refresh-konventsiya.
let priceTouched = false;
let lastServicesTotal = null;

export function wireBookingActualPrice() {
  const input = document.getElementById('bkActualPrice');
  const saveBtn = document.getElementById('bkActualPriceSave');
  const resultEl = document.getElementById('bkActualPriceResult');
  if (!input || !saveBtn || !resultEl) return; // страница без этого блока (crm-master.html) - no-op
  const commentEl = document.getElementById('bkStaffComment');

  window.renderBookingActualPrice = function renderBookingActualPrice(actualPrice, staffComment = '') {
    // Сохранённая фактическая сумма - это уже осознанно вписанная цифра (скидка),
    // поэтому она считается "тронутой": подстановка суммы услуг её не перебьёт.
    priceTouched = actualPrice != null;
    input.value = actualPrice ?? '';
    if (commentEl) commentEl.value = staffComment ?? '';
    resultEl.hidden = true;
  };

  // Сумма выбранных услуг из формы. null - услуг не выбрано, поле оставляем пустым
  // ("как по услугам"), а не пишем 0: ноль - валидная фактическая сумма ("постригли
  // бесплатно"), и путать эти два состояния нельзя.
  window.syncBookingActualPrice = function syncBookingActualPrice(servicesTotal) {
    lastServicesTotal = servicesTotal;
    if (priceTouched) return;
    input.value = servicesTotal == null ? '' : String(servicesTotal);
  };

  if (!input.dataset.touchWired) {
    input.dataset.touchWired = '1';
    input.addEventListener('input', () => {
      // Поле стёрли полностью - это снова "как по услугам", а не ручная сумма:
      // возвращаем автоподстановку, чтобы пустым поле не оставалось по недосмотру.
      priceTouched = input.value.trim() !== '';
      if (!priceTouched) input.value = lastServicesTotal == null ? '' : String(lastServicesTotal);
    });
  }

  if (!saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.addEventListener('click', async () => {
      const panel = bookingPanel();
      const bookingId = panel?.dataset.bookingId;
      if (!bookingId) return;
      // Пустое поле - явный сброс на null ("фактическая = как по услугам"), а не 0
      // (0 ₽ - это тоже валидный кейс, "постригли бесплатно", отличается от "не
      // указано вообще").
      const raw = input.value.trim();
      const actualPrice = raw === '' ? null : Number(raw);
      if (actualPrice !== null && (!Number.isFinite(actualPrice) || actualPrice < 0)) {
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--err';
        resultEl.textContent = 'Сумма должна быть числом от 0';
        return;
      }
      const comment = commentEl ? commentEl.value.trim() : null;
      const originalLabel = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Сохраняю…';
      resultEl.hidden = true;
      try {
        const res = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/actual-price`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          // Поле comment шлём только со страниц, где оно есть: без него бэкенд
          // сознательно НЕ трогает уже сохранённый комментарий (handleBookingActualPrice),
          // и старая разметка не стирала бы чужое объяснение молча.
          body: JSON.stringify(commentEl ? { actualPrice, comment } : { actualPrice }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) throw new Error(ACTUAL_PRICE_ERROR_TEXT[data.error] || data.error || `HTTP ${res.status}`);
        // Сохранённая сумма становится "тронутой" (её больше нельзя молча перебить
        // автоподстановкой), сброс на пустое - наоборот, снова следует за услугами.
        priceTouched = actualPrice != null;
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--ok';
        resultEl.textContent = actualPrice === null
          ? 'Сохранено - сумма считается по услугам'
          : comment
            ? 'Сохранено: сумма и комментарий'
            : 'Сохранено';
      } catch (err) {
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--err';
        resultEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel;
      }
    });
  }
}

// Ошибки комментария от бэкенда (normalizeStaffComment, api/routes/bookings.js) -
// человеческим языком: "comment_too_long" в интерфейсе сотруднику ничего не говорит.
const ACTUAL_PRICE_ERROR_TEXT = {
  comment_too_long: 'комментарий слишком длинный - до 500 знаков',
  invalid_comment: 'комментарий должен быть текстом',
  invalid_actual_price: 'сумма должна быть числом от 0',
  booking_not_found: 'запись не найдена - возможно, её уже удалили',
  forbidden: 'нет прав менять эту запись (другая точка)',
};
