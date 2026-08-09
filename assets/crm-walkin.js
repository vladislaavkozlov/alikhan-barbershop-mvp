// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Визард записи walk-in клиента (без
// предварительной записи + "Записать снова" из карточки клиента) + форма "Добавить
// продажу" сразу после сохранения. Самая крупная отдельная функция файла. Код
// перенесён 1в1, поведение не менялось.
import { el, formatMoney, todayStr, pad2 } from './crm-shared.js';
import { renderDateSelect, renderTimeSelect, timeSelectValue, dateSelectValue } from './crm-widgets.js';
import { API, getToken } from './crm-auth.js';
import { renderLiveProof } from './crm-dashboard.js';
import { mergeServiceCombos, isServiceBlockedByCombo } from '../storage.js';

// Задача Влада (01.08.2026): "Клиент без предварительной записи" была рисунком -
// кнопка ничего не сохраняла, список услуг был одинаковый для любого мастера, поле
// "мастер" - обычный текст, который нужно было вписывать руками. Реальная версия:
// мастер известен заранее (своя страница мастера - он сам; у владельца/админа -
// кнопка "+" в шапке колонки нужного мастера в расписании), список услуг - только
// те, что реально есть у ЭТОГО мастера в master-services (у мастеров разный прайс,
// см. миграцию 004), можно отметить несколько (Окно 11 - тот же контракт serviceIds,
// что и на публичном сайте). Сохранение - тот же POST /bookings, что использует
// сайт, статус сразу "пришёл" (PATCH /bookings/:id/status) - клиент физически уже
// в кресле, ждать подтверждения не у кого.
// Состояние формы walk-in - на уровне МОДУЛЯ, не внутри wireWalkIn() (найдено
// 08.08.2026, изначально при добавлении тумблера "Запись задним числом" - сам
// тумблер тем же вечером убран по прямой правке Влада ("зачем тумблер, если можно
// просто дать выбрать дату как обычно") в пользу простого снятия minDate у
// date-picker насовсем, но сама находка и фикс ниже остаются актуальны независимо
// от тумблера). wireWalkIn() вызывается заново
// на каждый renderLiveProof() - не только при заходе на страницу, а и ПОСЛЕ КАЖДОЙ
// успешной записи (см. её же вызов в конце submit-обработчика ниже). window.
// openSlotBooking/window.openRebookBooking переопределяются на каждый такой вызов,
// но submitBtn/cancelBtn/soloBtn привязываются ОДИН раз (dataset.wired) и навсегда
// остаются на ПЕРВОЙ версии openForWalkin(). Если currentMasterId/selected/rebookMode
// жили бы внутри wireWalkIn() (было так до этой правки) - после первой же успешной
// записи повторный клик по слоту календаря молча переставал бы сохраняться: чекбоксы
// обновляли бы Set ВТОРОГО вызова, а Submit (привязан к ПЕРВОМУ) читал бы Set
// первого, к тому моменту уже пустой - `if (selected.size === 0) return` без единой
// ошибки в интерфейсе. Тот же паттерн уже пойман и задокументирован для
// crm-booking-status.js - reference_barbershop-dataset-wired-refresh-konventsiya.md.
let currentMasterId = null;
let selected = new Set();
const checkboxByService = new Map();
let rebookMode = false;

export function wireWalkIn(staff, services, masterServices) {
  const form = el('walkinForm');
  const picker = el('wfServicePicker');
  const summary = el('wfSummary');
  const submitBtn = el('wfSubmit');
  const cancelBtn = el('wfCancel');
  const resultEl = el('wfResult');
  const nameLabel = el('wfMasterName');
  const clientNameEl = el('wfClientName');
  const clientPhoneEl = el('wfClientPhone');
  if (!form || !picker || !summary || !submitBtn || !cancelBtn || !resultEl || !nameLabel || !clientNameEl || !clientPhoneEl) {
    return; // страница без этого блока (или он ещё не дошёл до нужной страницы)
  }
  // Окно 39 (06.08.2026) - "Записать снова" (карточка клиента) открывает ту же форму
  // в режиме будущей записи: дата/время выбираются виджетами (не "прямо сейчас"), после
  // сохранения статус остаётся 'planned' (не форсируется 'done' - клиента физически ещё
  // нет в кресле). modeLabelEl/dateTimeRow - опциональны (crm-admin.html/crm-master.html
  // этот блок не получали в этом окне, getElementById безопасно вернёт null, весь режим
  // rebook просто недоступен там, обычный walk-in работает как раньше).
  const modeLabelEl = el('wfModeLabel');
  const dateTimeRow = el('wfDateTimeRow');
  const hasRebookUi = !!(modeLabelEl && dateTimeRow);

  // Разворот 08.08.2026 (тот же вечер) - Влад прямо спросил "зачем тумблер, если
  // можно просто дать записать как обычно": отдельный "Запись задним числом" убран,
  // date-picker в CRM теперь ПРОСТО не ограничен снизу вообще (ни в rebookMode/slot,
  // ни в обычном walk-in) - см. renderDateSelect ниже без 4-го аргумента minDate.
  // Публичный сайт (index.html/app.js, анонимные запросы) по-прежнему ограничен -
  // это держит бэкенд (createBookingTx, isStaff), не фронт, см. api/routes/bookings.js.

  // Блок В (ТЗ-готовность-к-продакшену, 01.08.2026) - "Добавить продажу", POST /sales
  // уже готов и рабочий на бэкенде (owner/admin-only), просто не вызывался ни разу с
  // фронта. Единственное место с РЕАЛЬНЫМ booking id прямо сейчас - только что
  // созданная walk-in запись (см. ниже): статичный календарь ещё не подключён к
  // реальным данным (Блок В, "Календарь записей" - отдельная крупная задача), поэтому
  // продажу через клик по примерной карточке в календаре пока не привязать честно.
  // Элементов нет на crm-master.html (мастер не имеет доступа к /sales на сервере,
  // requireRole ['owner','admin']) - тогда всё ниже no-op.
  const saleForm = el('wfSaleForm');
  const saleItemEl = el('wfSaleItem');
  const saleAmountEl = el('wfSaleAmount');
  const saleSubmitBtn = el('wfSaleSubmit');
  const saleResultEl = el('wfSaleResult');
  const hasSaleForm = saleForm && saleItemEl && saleAmountEl && saleSubmitBtn && saleResultEl;

  const servicesFor = (masterId) =>
    masterServices
      .filter((r) => r.masterId === masterId)
      .map((r) => ({ ...r, name: services.find((s) => s.id === r.serviceId)?.name ?? r.serviceId }));

  // Правка 03.08.2026: та же логика комплекса "стрижка+борода", что теперь у
  // публичной записи (storage.js SERVICE_COMBOS) - выбор комплекса блокирует его
  // компоненты, отдельный выбор обоих компонентов сам сворачивается в комплекс.
  function syncCheckboxes() {
    for (const [serviceId, input] of checkboxByService) {
      const isSelected = selected.has(serviceId);
      input.checked = isSelected;
      input.disabled = !isSelected && isServiceBlockedByCombo(serviceId, selected);
      input.closest('.service-check')?.classList.toggle('service-check--blocked', input.disabled);
    }
  }

  function renderSummary() {
    const rows = servicesFor(currentMasterId).filter((r) => selected.has(r.serviceId));
    if (rows.length === 0) {
      summary.textContent = 'Выберите хотя бы одну услугу';
      submitBtn.disabled = true;
      return;
    }
    const totalMin = rows.reduce((s, r) => s + r.durationMin, 0);
    const totalPrice = rows.reduce((s, r) => s + r.price, 0);
    summary.textContent = `Выбрано услуг: ${rows.length} · итого ${totalMin} мин · ${formatMoney(totalPrice)}`;
    submitBtn.disabled = false;
  }

  function renderPicker(masterId) {
    picker.innerHTML = '';
    selected = new Set();
    checkboxByService.clear();
    const rows = servicesFor(masterId);
    if (rows.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'section-hint';
      hint.textContent = 'У этого мастера пока не назначено ни одной услуги в прайсе';
      picker.appendChild(hint);
    }
    for (const row of rows) {
      const label = document.createElement('label');
      label.className = 'service-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = row.serviceId;
      const span = document.createElement('span');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sc-name';
      nameSpan.textContent = row.name;
      const meta = document.createElement('span');
      meta.className = 'sc-meta';
      const priceSpan = document.createElement('span');
      priceSpan.className = 'sc-price';
      priceSpan.textContent = formatMoney(row.price);
      const dot = document.createElement('span');
      dot.className = 'sc-dot';
      dot.textContent = '·';
      const durationSpan = document.createElement('span');
      durationSpan.className = 'sc-duration';
      durationSpan.textContent = `${row.durationMin} мин`;
      meta.append(priceSpan, dot, durationSpan);
      span.append(nameSpan, meta);
      label.append(input, span);
      checkboxByService.set(row.serviceId, input);
      input.addEventListener('change', () => {
        if (isServiceBlockedByCombo(row.serviceId, selected)) {
          input.checked = false; // защита от гонки клика раньше, чем disabled применился
          return;
        }
        if (input.checked) selected.add(row.serviceId);
        else selected.delete(row.serviceId);
        selected = mergeServiceCombos(selected);
        syncCheckboxes();
        renderSummary();
      });
      picker.appendChild(label);
    }
    renderSummary();
  }

  function openForWalkin(masterId, masterName, options = {}) {
    currentMasterId = masterId;
    nameLabel.textContent = masterName;
    rebookMode = hasRebookUi && !!(options.rebook || options.slot);
    resultEl.hidden = true;
    if (hasSaleForm) {
      saleForm.hidden = true;
      delete saleForm.dataset.bookingId;
      saleItemEl.value = '';
      saleAmountEl.value = '';
      saleResultEl.hidden = true;
    }
    if (hasRebookUi) {
      // Окно 43 (07.08.2026) - тот же режим "будущая запись" (dateTimeRow виден,
      // статус после сохранения остаётся 'planned'), что уже использует "Записать
      // снова" (Окно 39), теперь и для клика по пустому слоту в дневном календаре
      // (assets/crm-calendar.js, window.openSlotBooking ниже) - подпись отдельная,
      // "Повторная запись" была бы нечестной для клиента, которого выбирают заново.
      modeLabelEl.textContent = options.slot ? 'Новая запись на выбранное время' : rebookMode ? 'Повторная запись' : 'Новая запись без предзаписи';
      dateTimeRow.hidden = !rebookMode;
      if (rebookMode) {
        // Дефолт - сегодня и ближайшее 15-минутное время в рабочем окне магазина
        // (10:00-20:00, SHOP_TIME_OPTIONS в crm-widgets.js), если конкретные
        // дата/время не переданы явно (options.date/options.startTime - клик по
        // слоту календаря их всегда передаёт) - владелец меняет на любое реальное
        // свободное, доступность проверяет сервер при сохранении.
        const now = new Date();
        const roundedMin = Math.min(20 * 60, Math.max(10 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15));
        const defaultTime = `${String(Math.floor(roundedMin / 60)).padStart(2, '0')}:${String(roundedMin % 60).padStart(2, '0')}`;
        // Без 4-го аргумента (minDate) - убран по правке 08.08.2026, прошлые даты
        // в CRM теперь выбираются как обычные, без отдельного тумблера-подтверждения
        // (см. комментарий у объявления hasRebookUi выше).
        renderDateSelect('wfDate-slot', 'wfDateValue', options.date || todayStr());
        renderTimeSelect('wfTime-slot', 'wfTimeValue', options.startTime || defaultTime);
      }
    }
    clientNameEl.value = options.clientName || '';
    clientPhoneEl.value = options.clientPhone || '';
    renderPicker(masterId);
    if (rebookMode && options.serviceIds?.length) {
      const available = new Set(checkboxByService.keys());
      selected = new Set(options.serviceIds.filter((id) => available.has(id)));
      selected = mergeServiceCombos(selected);
      syncCheckboxes();
      renderSummary();
    }
    form.hidden = false;
    // Правка 07.08.2026 - было block:'start': форма теперь лежит В DOM ПОД календарём
    // (crm-owner.html, тот же приём, что уже фиксирует высоту .schedule-track - см.
    // комментарий там же), а 'start' насильно прокручивал страницу так, что календарь
    // "День" уезжал за верх экрана - ровно жалоба "вкладка скачет". 'nearest' скроллит,
    // только если форма реально не видна, и на минимальное расстояние - клик по слоту
    // календаря уже держит нужное место в поле зрения, дальний прыжок не нужен.
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // crm-master.html: единственный мастер - он и есть залогиненный сотрудник, выбирать не из чего
  const soloBtn = el('walkinSoloTrigger');
  if (soloBtn && !soloBtn.dataset.wired) {
    soloBtn.dataset.wired = '1';
    soloBtn.addEventListener('click', () => openForWalkin(staff.id, staff.name));
  }

  if (!cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', () => {
      form.hidden = true;
    });
  }

  if (!submitBtn.dataset.wired) {
    submitBtn.dataset.wired = '1';
    submitBtn.addEventListener('click', async () => {
      if (selected.size === 0 || !currentMasterId) return;
      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Сохраняю…';
      try {
        let date;
        let startTime;
        if (rebookMode) {
          // "Записать снова" - дата/время выбраны заново виджетами (не "прямо сейчас"),
          // реальная доступность проверяется этим же POST /bookings (overlap/
          // schedule_blocked/past_time - createBookingTx, server.mjs).
          date = dateSelectValue('wfDateValue');
          startTime = timeSelectValue('wfTimeValue');
          if (!date || !startTime) throw new Error('укажите дату и время');
        } else {
          const now = new Date();
          const rounded = new Date(Math.ceil(now.getTime() / (5 * 60000)) * 5 * 60000);
          date = todayStr();
          startTime = `${pad2(rounded.getHours())}:${pad2(rounded.getMinutes())}`;
        }
        const res = await fetch(`${API}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            masterId: currentMasterId,
            serviceIds: [...selected],
            date,
            startTime,
            clientName: clientNameEl.value.trim() || null,
            clientPhone: clientPhoneEl.value.trim() || null,
            channel: 'admin',
          }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          const REASON_TEXT = {
            overlap: 'у мастера уже занято это время',
            schedule_blocked: 'у мастера в это время перерыв или выходной',
            past_time: 'нельзя записать в прошлое',
            master_not_bookable: 'у мастера ещё не настроен график',
          };
          throw new Error(REASON_TEXT[data.reason] || data.error || `HTTP ${res.status}`);
        }
        // Обычный walk-in - клиент физически уже в кресле, статус сразу "пришёл".
        // "Записать снова" (rebookMode) - это будущая запись, статус остаётся 'planned'
        // по умолчанию (createBookingTx), PATCH здесь был бы нечестным (клиента ещё нет).
        if (!rebookMode) {
          await fetch(`${API}/bookings/${encodeURIComponent(data.booking.id)}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ status: 'done' }),
          });
        }
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--ok';
        const whenText = rebookMode ? `${date} ${startTime}` : startTime;
        resultEl.textContent = `Готово: ${nameLabel.textContent}, ${whenText}, ${data.booking.totalDurationMin} мин, ${formatMoney(data.booking.totalPrice)}`;
        // "Добавить продажу" - только для walk-in (клиент физически в кресле сейчас).
        // Будущая запись (rebookMode) продажу добавит администратор в день визита.
        if (hasSaleForm && !rebookMode) {
          saleForm.dataset.bookingId = data.booking.id;
          saleForm.hidden = false;
        }
        renderLiveProof(staff);
      } catch (err) {
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--err';
        resultEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        submitBtn.disabled = selected.size === 0;
        submitBtn.textContent = originalLabel;
      }
    });
  }

  if (hasSaleForm && !saleSubmitBtn.dataset.wired) {
    saleSubmitBtn.dataset.wired = '1';
    saleSubmitBtn.addEventListener('click', async () => {
      const bookingId = saleForm.dataset.bookingId;
      const itemName = saleItemEl.value.trim();
      const amount = Number(saleAmountEl.value);
      if (!bookingId || !itemName || !Number.isFinite(amount) || amount <= 0) {
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--err';
        saleResultEl.textContent = 'Укажите название товара и сумму больше нуля';
        return;
      }
      const originalLabel = saleSubmitBtn.textContent;
      saleSubmitBtn.disabled = true;
      saleSubmitBtn.textContent = 'Сохраняю…';
      try {
        const res = await fetch(`${API}/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ bookingId, itemName, amount }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--ok';
        saleResultEl.textContent = `Продажа добавлена: ${itemName}, ${formatMoney(amount)}`;
        saleItemEl.value = '';
        saleAmountEl.value = '';
      } catch (err) {
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--err';
        saleResultEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        saleSubmitBtn.disabled = false;
        saleSubmitBtn.textContent = originalLabel;
      }
    });
  }

  // Окно 39 (06.08.2026) - точка входа для "Записать снова" (карточка клиента,
  // assets/crm-clients.js). Глобальная функция (не export ES-модуля) - тот же приём,
  // что у остальных onclick-обработчиков этой страницы (openBooking и т.д. в
  // mockup-crm.js), потому что клиентская карточка рисует кнопку динамически, не
  // статичной разметкой с прямым import. hasRebookUi=false (страница без
  // wfModeLabel/wfDateTimeRow, пока только crm-owner.html) - выходим тихо, вызывающий
  // код (openClientCard) сам прячет кнопку "Записать снова", если функции нет.
  if (hasRebookUi) {
    window.openRebookBooking = (masterId, masterName, clientName, clientPhone, serviceIds) => {
      openForWalkin(masterId, masterName, { rebook: true, clientName, clientPhone, serviceIds });
    };
  }

  // Окно 43 (07.08.2026) - точка входа для клика по пустому слоту в дневном
  // календаре (assets/crm-calendar.js, wireEmptySlotInteraction). Тот же приём, что
  // и у window.openRebookBooking чуть выше - глобальная функция, не export ES-модуля,
  // потому что вызывающий код рисует превью-слот динамически. hasRebookUi=false
  // (crm-admin.html/crm-master.html пока без wfDateTimeRow) - функция не
  // регистрируется вовсе, crm-calendar.js проверяет typeof window.openSlotBooking
  // перед вызовом и тихо не показывает превью/клик там, где открыть нечего.
  if (hasRebookUi) {
    window.openSlotBooking = (masterId, masterName, date, startTime) => {
      openForWalkin(masterId, masterName, { slot: true, date, startTime });
    };
  }
}
