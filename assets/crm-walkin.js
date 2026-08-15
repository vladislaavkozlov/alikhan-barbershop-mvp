// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Визард записи walk-in клиента (без
// предварительной записи + "Записать снова" из карточки клиента) + форма "Добавить
// продажу" сразу после сохранения. Самая крупная отдельная функция файла. Код
// перенесён 1в1, поведение не менялось.
import { el, formatMoney, todayStr, pad2 } from './crm-shared.js';
import { escapeHtml } from './crm-schedule-shared.js';
import { renderDateSelect, renderTimeSelect, timeSelectValue, dateSelectValue } from './crm-widgets.js';
import { API, getToken } from './crm-auth.js';
import { renderLiveProof } from './crm-dashboard.js';
import { RADIO_ID_TO_STATUS, applyNoShowStreakAfterStatus } from './crm-booking-status.js';
import { mergeServiceCombos, isServiceBlockedByCombo } from '../storage.js';
import { reportError, reportSuccess } from './crm-toast.js';

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

// Окно 55, Задача B (10.08.2026) - опознание клиента по телефону. Состояние на уровне
// МОДУЛЯ по той же причине, что и всё выше: wireWalkIn() вызывается заново на каждый
// renderLiveProof(), а обработчик input телефона привязывается один раз (dataset.wired)
// и остаётся на ПЕРВОЙ версии функций - жившее внутри wireWalkIn() состояние поиска
// после первой же записи расходилось бы с тем, что читает обработчик.
// lookupSeq - защита от гонки ответов: администратор дописывает цифры быстрее, чем
// отвечает сервер, и ответ по КОРОТКОМУ префиксу мог прийти после ответа по полному
// номеру и перезаписать правильный признак неправильным.
let lookupSeq = 0;
let lookupPhoneKey = null;

// Окно 55, Задача C - режим редактирования существующей записи. editMode держим на
// уровне модуля по той же причине, что rebookMode выше (обработчик Submit привязан к
// первой версии функции и читает модульное состояние, не своё замыкание).
// editBooking - снимок открытой записи: с чем сравнивать при сохранении, чтобы
// понять, нужен ли вообще PATCH /reschedule (перенос "без изменений" - лишний запрос
// и лишнее уведомление мастеру, planRescheduleNotifications на бэкенде такой случай
// тоже отсекает, но гонять сеть впустую незачем).
let editMode = false;
let editBooking = null;

// Правка 13.08.2026 - услуги, УЖЕ сохранённые в открытой записи. Раньше их
// блокировал отдельный блок "Добавить услугу к записи" (собственный чекбокс-лист),
// теперь он убран (Влад: "зачем, выше уже есть Услуги") и блокировку держит сам
// верхний список. Блокировка не косметика: PATCH /bookings/:id/services умеет ТОЛЬКО
// добавление (handleBookingAddServices), снятая галочка ничего не удалила бы -
// интерфейс не должен обещать того, чего бэкенд не делает. На уровне модуля - по той
// же причине, что и всё состояние выше (обработчики привязаны к первой версии
// функций, см. комментарий у currentMasterId).
let lockedServices = new Set();

// ── Кнопка "Сохранить изменения" неактивна, пока ничего не изменили ──────────
// Правка 13.08.2026 (Влад: "кнопка должна быть неактивна до внесения изменений и
// должна учитывать изменения всех полей во вкладке"). Раньше она была активна всегда,
// когда в записи есть хоть одна услуга - нажатие без единой правки уходило в сеть и
// отвечало, что менять нечего.
// editBaseline - снимок ВСЕХ сохраняемых полей на момент открытия записи (и заново
// после каждого успешного сохранения). Сравнение идёт с ним, а не с editBooking:
// сумма и комментарий в editBooking не живут, а именно они чаще всего и меняются.
// На уровне модуля - по той же причине, что и всё состояние выше: обработчики
// привязаны один раз (dataset.wired) и читают модульные переменные, не своё замыкание.
// Статус визита в снимок ВХОДИТ (правка того же дня, Влад: "меняешь статус, жмёшь
// сохранить - а система отвечает, что менять было нечего"). С вечера 13.08.2026 он
// в базу мимо этой кнопки вообще не уходит: клик по радио только переключает выбор,
// а PATCH /bookings/:id/status шлёт submitEdit наравне с услугами, переносом и
// суммой (Влад: "изменения должны вступать в силу только при нажатии на кнопку
// 'Сохранить изменения'").
// Имя и телефон клиента в снимок НЕ входят: у существующей записи бэкенд их менять
// не умеет (роута нет), и включать их в признак "есть что сохранить" значило бы
// обещать сохранение, которого не произойдёт.
let editBaseline = null;

function checkedStatusRadioId() {
  return document.querySelector('input[name="bstatus"]:checked')?.id || '';
}

function editStateSnapshot() {
  return {
    masterId: currentMasterId || '',
    date: dateSelectValue('wfDateValue') || '',
    startTime: timeSelectValue('wfTimeValue') || '',
    services: [...selected].sort().join(','),
    actualPrice: (el('bkActualPrice')?.value ?? '').trim(),
    comment: (el('bkStaffComment')?.value ?? '').trim(),
    status: checkedStatusRadioId(),
  };
}

function isEditDirty() {
  if (!editBaseline) return false;
  const now = editStateSnapshot();
  return Object.keys(editBaseline).some((key) => editBaseline[key] !== now[key]);
}

// Единственное место, где решается, доступна ли кнопка сохранения. В режиме создания
// правило прежнее (нужна хотя бы одна услуга), в режиме редактирования добавляется
// "и хоть что-то изменилось".
function updateSubmitState() {
  const btn = el('wfSubmit');
  if (!btn) return;
  btn.disabled = editMode
    ? selected.size === 0 || !isEditDirty()
    : selected.size === 0;
}

// Поля, которые меняются мимо renderSummary: дата (customdate:change), время и мастер
// (customselect:change - оба виджета шлют его, см. mockup-crm.js), сумма и комментарий
// (обычный input). Слушатели вешаются один раз на статичные узлы, а зовут модульную
// updateSubmitState - поэтому повторный вызов wireWalkIn() из renderLiveProof() их не
// задваивает и не оставляет на устаревшем замыкании.
function wireDirtyWatchers() {
  const form = el('walkinForm');
  if (!form || form.dataset.dirtyWired) return;
  form.dataset.dirtyWired = '1';
  form.addEventListener('customselect:change', updateSubmitState);
  form.addEventListener('customdate:change', updateSubmitState);
  for (const id of ['bkActualPrice', 'bkStaffComment']) {
    el(id)?.addEventListener('input', updateSubmitState);
  }
  // Статус визита - обычные radio внутри формы, change всплывает
  form.addEventListener('change', (e) => {
    if (e.target?.name === 'bstatus') updateSubmitState();
  });
}

// Та же нормализация, что на бэкенде (normalizePhoneKey, api/routes/clients.js) -
// последние 10 цифр. Дублируется намеренно: тянуть серверный модуль во фронтенд ради
// одной строки нельзя (это ES-модуль бэкенда с зависимостями на pg), а расхождение
// формул дало бы "ищу по одному ключу, нашёл по другому". 10 цифр = момент, когда
// номер введён полностью и есть что искать.
const PHONE_KEY_DIGITS = 10;
function phoneKeyOf(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= PHONE_KEY_DIGITS ? digits.slice(-PHONE_KEY_DIGITS) : null;
}

// "1 визит / 2 визита / 5 визитов". Такая же функция (ruPlural) есть в
// assets/mockup-crm.js, но тот файл - classic <script>, не ES-модуль: импортировать
// оттуда нечего, а завязываться на глобаль ради трёх слов - хуже, чем локальная копия
// (и mockup-crm.js по Задаче D частично уезжает).
function ruPluralVisits(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'визит';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'визита';
  return 'визитов';
}

// Окно 55, Задача C - staffList (4-й параметр) добавлен ради дропдауна мастера в
// режиме редактирования: до этого окна форма всегда открывалась на ЗАРАНЕЕ известного
// мастера (клик по его колонке календаря), выбирать было не из чего. Передаётся из
// assets/crm-dashboard.js, где список уже загружен для остальных виджетов - второго
// запроса /staff не заводим.
export function wireWalkIn(staff, services, masterServices, staffList = []) {
  const form = el('walkinForm');
  const picker = el('wfServicePicker');
  const summary = el('wfSummary');
  const submitBtn = el('wfSubmit');
  const cancelBtn = el('wfCancel');
  const resultEl = el('wfResult');
  const nameLabel = el('wfMasterName');
  const clientNameEl = el('wfClientName');
  const clientPhoneEl = el('wfClientPhone');
  // summary (#wfSummary, строка "Выбрано услуг: N · итого M мин · сумма") с 13.08.2026
  // опционален: на owner/admin его убрали (Влад: "и так понятно визуально", вместе с
  // "Выберите хотя бы одну услугу"), состав виден по самим чекбоксам. Обязательным он
  // остаться не мог - иначе его удаление из разметки выключило бы всю форму целиком.
  if (!form || !picker || !submitBtn || !cancelBtn || !resultEl || !nameLabel || !clientNameEl || !clientPhoneEl) {
    return; // страница без этого блока (или он ещё не дошёл до нужной страницы)
  }
  wireDirtyWatchers();
  // Окно 39 (06.08.2026) - "Записать снова" (карточка клиента) открывает ту же форму
  // в режиме будущей записи: дата/время выбираются виджетами (не "прямо сейчас"), после
  // сохранения статус остаётся 'planned' (не форсируется 'done' - клиента физически ещё
  // нет в кресле). modeLabelEl/dateTimeRow - опциональны (crm-admin.html/crm-master.html
  // этот блок не получали в этом окне, getElementById безопасно вернёт null, весь режим
  // rebook просто недоступен там, обычный walk-in работает как раньше).
  const modeLabelEl = el('wfModeLabel');
  const dateTimeRow = el('wfDateTimeRow');
  const hasRebookUi = !!(modeLabelEl && dateTimeRow);

  // Окно 55, Задача C - элементы режима "редактирование существующей записи". Тот же
  // приём опциональности, что у hasRebookUi: страница без этих блоков
  // (crm-master.html - мастер записи не переносит, решение Влада 08.08.2026,
  // подтверждено бэкендом: requireRole owner/admin у /reschedule) просто не получает
  // режим edit, остальная форма работает как раньше.
  const masterRow = el('wfMasterRow');
  const editControls = el('wfEditControls');
  const editExtras = el('wfEditExtras');
  const statusNote = el('bk-status-note');
  // Правка 13.08.2026 - зона удаления переехала в самый низ формы (Влад), поэтому её
  // видимостью управляем отдельным элементом, а не тем, что #bkDeleteRow лежит внутри
  // #wfEditControls. Подсказка про уже оказанные услуги живёт у верхнего списка услуг
  // и показывается только в режиме edit. Оба опциональны - страница без них (старая
  // разметка/crm-master.html) просто работает как раньше.
  const dangerZone = el('wfDangerZone');
  const serviceEditHint = el('wfServiceEditHint');
  const hasEditUi = !!(hasRebookUi && masterRow && editControls);

  // Отображаемый статус → id радио. Обратная к RADIO_ID_TO_STATUS в
  // assets/crm-booking-status.js (там же живёт сам PATCH /bookings/:id/status -
  // механику этого роута окно не трогает, только переносит контрол в новую форму).
  const STATUS_TO_RADIO_ID = { planned: 'st-wait', done: 'st-came', no_show: 'st-no' };

  // Дропдаун мастера для режима edit. Кастомный .custom-select (КОНВЕНЦИЯ-
  // ВСПЛЫВАЮЩИЕ-ЭЛЕМЕНТЫ.md), тот же виджет, что у "Закреплён за мастером" - строим
  // его тем же HTML-контрактом (data-value + onclick-хуки mockup-crm.js), потому что
  // интерактивность .custom-select живёт там и резолвится через window.
  // Список - только те, кто реально принимает клиентов (providesServices), а НЕ по
  // role === 'master': владелец Алиовсад сам стрижёт и обязан быть в списке, а
  // администратор без услуг - нет. Тем же признаком бэкенд отбирает мастеров для
  // расписания (serviceMasterIds, api/routes/staff.js) - берём тот же критерий, а не
  // свой. Текущий мастер записи добавляется всегда, даже если его уже сняли с услуг:
  // иначе открытая старая запись показала бы пустой дропдаун.
  function renderMasterSelect(selectedMasterId, { manual = false } = {}) {
    const slot = el('wfMaster-slot');
    if (!slot) return;
    const masters = (staffList || []).filter((s) => manual
      ? s.providesServices && s.hasWorkingSchedule !== false
      : s.providesServices || s.id === selectedMasterId
    );
    const current = masters.find((m) => m.id === selectedMasterId);
    const options = masters
      .map((m) => `<div class="custom-select-option${m.id === selectedMasterId ? ' selected' : ''}" onclick="pickCustomSelectOption(this)" data-value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</div>`)
      .join('');
    slot.innerHTML = `<div class="custom-select" id="wfMasterValue" data-value="${escapeHtml(selectedMasterId || '')}">
      <button type="button" class="custom-select-trigger" onclick="toggleCustomSelect(this)">${escapeHtml(current?.name || '')}</button>
      <div class="custom-select-list" hidden>${options}</div>
    </div>`;
    // Смена мастера меняет прайс/длительность (master_services, у мастеров разные
    // наборы) - перерисовываем список услуг под нового мастера и переносим уже
    // выбранные, какие у него есть. Молча оставить чужие услуги нельзя: бэкенд
    // ответит unknown_master_service (resolveRescheduleDuration), а владелец не
    // поймёт, почему сохранение не прошло.
    slot.querySelector('.custom-select')?.addEventListener('customselect:change', (e) => {
      const nextMasterId = e.detail.value;
      if (!nextMasterId || nextMasterId === currentMasterId) return;
      const keep = [...selected];
      currentMasterId = nextMasterId;
      nameLabel.textContent = masters.find((m) => m.id === nextMasterId)?.name || '';
      renderPicker(nextMasterId);
      const available = new Set(checkboxByService.keys());
      const kept = keep.filter((id) => available.has(id));
      selected = mergeServiceCombos(new Set(kept));
      syncCheckboxes();
      renderSummary();
      if (kept.length < keep.length) {
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--err';
        resultEl.textContent = 'У нового мастера нет части прежних услуг - отметьте, что он делает по факту';
      }
    });
  }

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
  // Свернуть "стрижка"+"борода" в комплекс можно только в услугу, которая реально
  // есть в прайсе ЭТОГО мастера (mergeServiceCombos, storage.js, делает ЗАМЕНУ: оба
  // компонента из набора удаляются, вместо них встаёт комбо). Иначе набор превращается
  // в id, которого нет ни в одном чекбоксе - список услуг на экране становится пустым
  // ("Выберите хотя бы одну услугу"), а фактическая сумма обнуляется, хотя услуги у
  // записи есть. Поймано живым прогоном 13.08.2026 на записи, где услуги-компоненты
  // проставлены по отдельности.
  function mergeCombosFor(ids) {
    const merged = mergeServiceCombos(ids);
    const available = new Set(servicesFor(currentMasterId).map((r) => r.serviceId));
    return [...merged].every((id) => available.has(id)) ? merged : new Set(ids);
  }

  function syncCheckboxes() {
    for (const [serviceId, input] of checkboxByService) {
      const isSelected = selected.has(serviceId);
      // Уже оказанная услуга открытой записи: отмечена и не снимается (снятие бэкенд
      // не умеет, см. lockedServices выше). Проверка идёт первой - комбо-логика ниже
      // не должна её перебить.
      const isLocked = lockedServices.has(serviceId);
      input.checked = isSelected || isLocked;
      input.disabled = isLocked || (!isSelected && isServiceBlockedByCombo(serviceId, selected));
      input.closest('.service-check')?.classList.toggle('service-check--blocked', input.disabled);
    }
  }

  // Сумма выбранных услуг по прайсу ТЕКУЩЕГО мастера (у мастеров цены разные,
  // master_services). null - услуг не выбрано вообще: это не "0 ₽", а "считать не из
  // чего", см. renderSummary ниже.
  function currentServicesTotal() {
    const rows = servicesFor(currentMasterId).filter((r) => selected.has(r.serviceId));
    if (rows.length === 0) return null;
    return rows.reduce((s, r) => s + r.price, 0);
  }

  function renderSummary() {
    const rows = servicesFor(currentMasterId).filter((r) => selected.has(r.serviceId));
    if (rows.length === 0) {
      if (summary) summary.textContent = 'Выберите хотя бы одну услугу';
      // Услуг нет - сумма услуг равна нулю, но подставлять "0 ₽" в фактическую сумму
      // нельзя: 0 - это реальный кейс "постригли бесплатно", а здесь состав ещё не
      // собран. Пустое значение = "как по услугам", тот же смысл, что и раньше.
      window.syncBookingActualPrice?.(null);
      updateSubmitState();
      return;
    }
    const totalMin = rows.reduce((s, r) => s + r.durationMin, 0);
    const totalPrice = rows.reduce((s, r) => s + r.price, 0);
    if (summary) summary.textContent = `Выбрано услуг: ${rows.length} · итого ${totalMin} мин · ${formatMoney(totalPrice)}`;
    // Правка 13.08.2026 (Влад: "почему если отличается?") - фактическая сумма больше
    // не пустое поле-загадка: в неё подтягивается сумма выбранных услуг, а
    // администратор правит её руками, когда с клиента взяли другую (скидка от
    // владельца). Пересчёт идёт и при изменении состава услуг - иначе добавленная
    // услуга молча оставляла бы в поле старую цифру. Значение, которое администратор
    // уже правил вручную, эта синхронизация не трогает (dirty-признак в
    // assets/crm-booking-status.js).
    window.syncBookingActualPrice?.(totalPrice);
    // Строго ПОСЛЕ автоподстановки суммы: она сама меняет поле "Фактическая сумма",
    // и состояние кнопки должно считаться уже по новому значению.
    updateSubmitState();
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
        selected = mergeCombosFor(selected);
        syncCheckboxes();
        renderSummary();
      });
      picker.appendChild(label);
    }
    renderSummary();
  }

  // ── Окно 55, Задача B - опознание клиента по телефону ──────────────────────
  // GET /clients?phone= (контракт Окна 54): 200 с карточкой, 404 если такого клиента
  // нет. Признак под полями, не alert - конвенция проекта на обратную связь формы
  // (.wf-result рядом). hintEl опционален: страница без него (будущая/чужая разметка)
  // просто не показывает признак, поиск тихо выключается целиком.
  const hintEl = el('wfClientHint');

  function setHint(kind, text, extraNode = null) {
    if (!hintEl) return;
    hintEl.hidden = false;
    hintEl.className = `wf-client-hint wf-client-hint--${kind}`;
    hintEl.textContent = text;
    if (extraNode) hintEl.appendChild(extraNode);
  }

  function clearHint() {
    if (!hintEl) return;
    hintEl.hidden = true;
    hintEl.textContent = '';
    lookupPhoneKey = null;
    lookupSeq += 1; // отменяет ответ на уже отправленный запрос (см. проверку seq ниже)
  }

  // Предложение, а не форсирование (промпт Задачи B): мастера/услуги последнего визита
  // подставляет кнопка, которую администратор нажимает сам. Переиспользуем ровно тот же
  // источник данных, что у "Записать снова" - card.lastVisit (getClientCard,
  // api/routes/clients.js), а не заводим второй способ узнать "как было в прошлый раз".
  // Мастера НЕ переключаем: форма открыта на конкретного мастера (клик по его колонке в
  // календаре), молчаливая пересадка клиента на другого - не то, о чём просили.
  function buildRepeatButton(card) {
    const lastVisit = card.lastVisit;
    if (!lastVisit || !lastVisit.services?.length) return null;
    const sameMaster = lastVisit.masterId === currentMasterId;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.id = 'wfClientRepeat';
    btn.textContent = sameMaster
      ? 'Как в прошлый раз'
      : `Как в прошлый раз (был у: ${lastVisit.masterName || lastVisit.masterId})`;
    btn.addEventListener('click', () => {
      // Услуги последнего визита, отфильтрованные по прайсу ТЕКУЩЕГО мастера: у
      // мастеров разный набор (master_services, Окно 10), чекбокса чужой услуги в
      // форме просто нет. Тот же приём фильтрации по available, что в rebook-режиме
      // openForWalkin ниже.
      const available = new Set(checkboxByService.keys());
      const wanted = lastVisit.services.map((s) => s.id).filter((id) => available.has(id));
      if (wanted.length === 0) {
        btn.disabled = true;
        btn.textContent = 'У этого мастера нет тех же услуг';
        return;
      }
      selected = mergeServiceCombos(new Set(wanted));
      syncCheckboxes();
      renderSummary();
      btn.disabled = true;
      btn.textContent = 'Подставлено';
    });
    return btn;
  }

  async function lookupClientByPhone(rawPhone) {
    const key = phoneKeyOf(rawPhone);
    if (!key) {
      // Номер ещё не дописан - признака нет вообще. "Новый клиент" на трёх цифрах
      // был бы враньём: по такому вводу никто не искал.
      clearHint();
      return;
    }
    if (key === lookupPhoneKey) return; // тот же номер, повторный запрос не нужен
    lookupPhoneKey = key;
    const seq = ++lookupSeq;
    setHint('pending', 'Ищу клиента…');
    try {
      const res = await fetch(`${API}/clients?phone=${encodeURIComponent(rawPhone)}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (seq !== lookupSeq) return; // пришёл ответ на устаревший запрос - игнорируем
      if (res.status === 404) {
        setHint('new', 'Новый клиент - впишите имя');
        return;
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, code: (await res.json().catch(() => null))?.error ?? null });
      const card = await res.json();
      if (seq !== lookupSeq) return;
      // Имя автозаполняется, но остаётся editable (промпт: "Влад может поправить
      // опечатку"). Уже набранное вручную имя не затираем - администратор мог начать
      // с имени, а телефон дописать после.
      if (!clientNameEl.value.trim()) clientNameEl.value = card.name || '';
      const visitsCount = card.visits?.length ?? 0;
      const visitsText = visitsCount > 0
        ? `${visitsCount} ${ruPluralVisits(visitsCount)}`
        : 'визитов пока не было';
      setHint('found', `Клиент найден: ${card.name || 'без имени'}, ${visitsText}`, buildRepeatButton(card));
    } catch (err) {
      if (seq !== lookupSeq) return;
      // Сеть/сервер не ответили - форма НЕ топится ошибкой (промпт п.4): запись
      // сохраняется как для нового клиента, бэкенд всё равно свяжет её с существующим
      // клиентом через ON CONFLICT (phone) при сохранении.
      setHint('new', 'Не удалось проверить клиента - можно продолжать как с новым');
      lookupPhoneKey = null; // следующий ввод пробует снова, а не молчит навсегда
    }
  }

  function openForWalkin(masterId, masterName, options = {}) {
    currentMasterId = masterId;
    nameLabel.textContent = masterName;
    editMode = hasEditUi && !!options.edit;
    editBooking = editMode ? { ...options.booking, masterId } : null;
    // 13.08.2026 - услуги записи стали полностью редактируемыми (PUT
    // /bookings/:id/services умеет и снятие), поэтому на owner/admin ничего не
    // блокируем: галочка снимается, состав сохраняется общей кнопкой. Блокировка
    // осталась только там, где снятие действительно недоступно - на странице
    // мастера (своя карточка, PATCH-только), её ставит wireBookingServiceEdit.
    lockedServices = new Set();
    if (serviceEditHint) serviceEditHint.hidden = !editMode;
    rebookMode = hasRebookUi && !!(options.rebook || options.slot || options.manual || editMode);
    resultEl.hidden = true;
    clearHint();
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
      modeLabelEl.textContent = editMode
        ? 'Редактирование записи'
        : options.slot ? 'Новая запись на выбранное время' : options.manual ? 'Новая запись' : rebookMode ? 'Повторная запись' : 'Новая запись без предзаписи';
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
      selected = mergeCombosFor(selected);
      syncCheckboxes();
      renderSummary();
    }
    // ── Окно 55, Задача C: обвязка режима редактирования ──────────────────────
    if (hasEditUi) {
      // Дропдаун мастера, зона удаления и фактическая сумма - опциональны: в кабинете
      // мастера этих блоков нет вовсе (перенос/удаление/actual-price ему закрыты на
      // бэкенде), поэтому каждый проверяется на существование, а не только editExtras.
      if (masterRow) masterRow.hidden = !(editMode || options.manual);
      editControls.hidden = !editMode;
      if (editExtras) editExtras.hidden = !editMode;
      if (dangerZone) dangerZone.hidden = !editMode;
      submitBtn.textContent = editMode ? 'Сохранить изменения' : 'Сохранить запись';
      if (masterRow && (editMode || options.manual)) {
        renderMasterSelect(masterId, { manual: !!options.manual });
      }
      if (editMode) {
        // id брони кладём на САМУ ФОРМУ: assets/crm-booking-status.js (статус,
        // удаление, услуги, фактическая сумма) читает его с элемента-панели. Раньше
        // панелью была карточка #bd-1, теперь - форма. Механика роутов не менялась,
        // сменился только носитель id - см. resolveBookingPanel там же.
        form.dataset.bookingId = editBooking.id || '';
        form.dataset.bookingMasterId = masterId || '';
        form.dataset.realStatus = editBooking.status || 'planned';
        form.dataset.noshowStreak = String(editBooking.noShowStreak ?? 0);
        form.dataset.requiresPrepayment = editBooking.requiresPrepayment ? 'true' : 'false';
        const radio = el(STATUS_TO_RADIO_ID[editBooking.status] || 'st-wait');
        if (radio) radio.checked = true;
        if (statusNote) statusNote.hidden = true;
        // Те же рендереры, что раньше звала openBooking() - блоки переехали в форму
        // вместе со своими id, обработчики не переписывались. renderBookingServiceEdit
        // остаётся вызовом-опцией: на crm-master.html отдельный блок "Добавить услугу
        // к записи" ещё живёт (там нет общей формы), на owner/admin он убран правкой
        // 13.08.2026 и функция просто не зарегистрирована.
        window.renderBookingServiceEdit?.(masterId, editBooking.serviceIds || []);
        window.renderBookingDeleteRow?.();
        // Комментарий сотрудника (13.08.2026, миграция 048) идёт вместе с суммой -
        // это одна мысль: "взяли столько, потому что вот почему". Сумма подставится
        // следом сама: renderPicker выше уже посчитал состав услуг, а сохранённая
        // фактическая сумма (если она есть) перебивает автоподстановку.
        window.renderBookingActualPrice?.(editBooking.actualPrice ?? null, editBooking.staffComment ?? '');
        window.syncBookingActualPrice?.(currentServicesTotal());
        window.updateNoShowUi?.();
        // Снимок "как было" - последним шагом, когда все поля записи уже отрисованы
        // (дата/время выше, услуги в renderPicker, сумма и комментарий строкой выше).
        // До этого момента любой промежуточный снимок был бы неполным, и кнопка
        // "Сохранить изменения" ожила бы сама собой сразу после открытия записи.
        editBaseline = editStateSnapshot();
      } else {
        editBaseline = null;
        delete form.dataset.bookingId;
        delete form.dataset.bookingMasterId;
        delete form.dataset.realStatus;
        delete form.dataset.noshowStreak;
        delete form.dataset.requiresPrepayment;
      }
    }
    updateSubmitState();
    const bookingCard = form.closest('details.booking-create-card');
    if (bookingCard && !bookingCard.open) bookingCard.open = true;
    form.hidden = false;
    // Правка 07.08.2026 - было block:'start': форма теперь лежит В DOM ПОД календарём
    // (crm-owner.html, тот же приём, что уже фиксирует высоту .schedule-track - см.
    // комментарий там же), а 'start' насильно прокручивал страницу так, что календарь
    // "День" уезжал за верх экрана - ровно жалоба "вкладка скачет". 'nearest' скроллит,
    // только если форма реально не видна, и на минимальное расстояние - клик по слоту
    // календаря уже держит нужное место в поле зрения, дальний прыжок не нужен.
    if (!options.manual) form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  window.openManualBooking = () => {
    const masters = (staffList || []).filter((candidate) =>
      candidate.providesServices && candidate.hasWorkingSchedule !== false
    );
    const master = masters[0];
    if (!master) {
      resultEl.hidden = false;
      resultEl.className = 'wf-result wf-result--err';
      resultEl.textContent = 'Нет мастера с рабочим графиком для новой записи';
      form.hidden = false;
      return;
    }
    openForWalkin(master.id, master.name, { manual: true });
  };
  if (el('scheduleCard-booking')?.open && form.hidden) window.openManualBooking();

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
      const bookingCard = form.closest('details.booking-create-card');
      if (bookingCard) bookingCard.open = false;
    });
  }

  // Окно 55, Задача B - поиск клиента по мере ввода телефона. Привязка один раз
  // (dataset.wired), как у всех обработчиков этого файла. Дебаунс 350 мс: без него
  // каждая цифра после десятой слала бы свой запрос. Событие input, не blur -
  // администратор должен увидеть "клиент найден" ещё до того, как уйдёт из поля.
  if (hintEl && !clientPhoneEl.dataset.lookupWired) {
    clientPhoneEl.dataset.lookupWired = '1';
    let debounceTimer = null;
    clientPhoneEl.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const raw = clientPhoneEl.value;
      if (!phoneKeyOf(raw)) {
        clearHint(); // номер стёрли/не дописали - признак сразу убираем, не ждём таймер
        return;
      }
      debounceTimer = setTimeout(() => lookupClientByPhone(raw), 350);
    });
  }

  // ── Окно 55, Задача C: сохранение изменений существующей записи ────────────
  // Два независимых шага по уже готовым роутам, механику которых окно не меняет:
  // 1) добавленные услуги - PATCH /bookings/:id/services (Окно 51);
  // 2) новый мастер/дата/время - PATCH /bookings/:id/reschedule (Окно 54).
  // Порядок именно такой: длительность нового слота сервер считает по составу услуг
  // (resolveRescheduleDuration), поэтому сначала состав, потом перенос - иначе слот
  // посчитался бы по старому набору и мог бы разъехаться с реальностью.
  const RESCHEDULE_REASON_TEXT = {
    overlap: 'на это время у мастера уже есть другая запись - выберите свободное',
    schedule_blocked: 'у мастера в это время перерыв или выходной',
    master_not_bookable: 'у этого мастера ещё не настроен график работы',
    master_not_accepting: 'этот сотрудник сейчас не принимает клиентов',
    past_time: 'нельзя перенести в прошлое',
  };
  const RESCHEDULE_ERROR_TEXT = {
    booking_cancelled: 'запись отменена - перенести её нельзя, создайте новую',
    booking_not_found: 'запись не найдена - возможно, её уже удалили',
    unknown_master_service: 'новый мастер не оказывает часть услуг этой записи - поправьте список услуг',
    unknown_master: 'такого мастера нет в системе',
    forbidden: 'нет прав переносить эту запись (другая точка)',
  };

  async function submitEdit() {
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняю…';
    resultEl.hidden = true;
    try {
      const bookingId = editBooking?.id;
      if (!bookingId) throw new Error('нет id записи');

      const date = dateSelectValue('wfDateValue');
      const startTime = timeSelectValue('wfTimeValue');
      if (!date || !startTime) throw new Error('укажите дату и время');

      // Услуги: шлём ПОЛНЫЙ состав (PUT /bookings/:id/services, 13.08.2026, Влад:
      // "клиент передумал уже в кресле - услугу можно будет изменить?"). Раньше
      // здесь был PATCH, умеющий только дописывать: снятая галочка ничего не
      // удаляла, и единственным способом исправить состав было удалить запись
      // целиком. Теперь снятие работает, конец слота пересчитывает сервер.
      const was = new Set(editBooking.serviceIds || []);
      const added = [...selected].filter((id) => !was.has(id));
      const removed = [...was].filter((id) => !selected.has(id));
      if (added.length > 0 || removed.length > 0) {
        const sr = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/services`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ serviceIds: [...selected] }),
        });
        const sdata = await sr.json().catch(() => ({}));
        if (!sr.ok || sdata.ok === false) {
          throw new Error(RESCHEDULE_ERROR_TEXT[sdata.error] || sdata.error || `HTTP ${sr.status}`);
        }
        editBooking.serviceIds = sdata.booking?.serviceIds || [...selected];
        // Состав поменялся - блокировка списка идёт за ним, иначе только что
        // снятая услуга осталась бы заблокированной до перезагрузки страницы.
        lockedServices = new Set();
        syncCheckboxes();
      }

      // Перенос - только если что-то реально изменилось. Пустой PATCH создал бы
      // уведомление мастеру о переносе, которого не было (бэкенд такой случай тоже
      // отсекает, planRescheduleNotifications, но лишний запрос ни к чему).
      const moved =
        currentMasterId !== editBooking.masterId ||
        date !== editBooking.date ||
        startTime !== editBooking.startTime;
      if (moved) {
        const rr = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/reschedule`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ masterId: currentMasterId, date, startTime }),
        });
        const rdata = await rr.json().catch(() => ({}));
        if (!rr.ok || rdata.ok === false) {
          // Разные тексты на разные причины (требование промпта) - "не удалось
          // сохранить" на конфликте слота не говорит администратору, что делать.
          const text =
            RESCHEDULE_REASON_TEXT[rdata.reason] ||
            RESCHEDULE_ERROR_TEXT[rdata.error] ||
            rdata.error ||
            `HTTP ${rr.status}`;
          throw new Error(text);
        }
        // Запись НЕ испорчена при ошибке (сервер откатывает транзакцию целиком) -
        // снимок обновляем только после успеха, иначе следующая попытка сравнивала
        // бы с несуществующим состоянием.
        editBooking.masterId = currentMasterId;
        editBooking.date = date;
        editBooking.startTime = startTime;
      }

      // Фактическая сумма и комментарий (13.08.2026, вторая итерация - Влад: "кнопка
      // 'Сохранить сумму и комментарий' как будто бы не нужна"). Тот же PATCH
      // /bookings/:id/actual-price, что был у своей кнопки - логика целиком осталась в
      // assets/crm-booking-status.js (window.saveBookingActualPrice), здесь только
      // вызов. ПОСЛЕДНИМ шагом: состав услуг выше мог изменить автоподставленную сумму,
      // и на сервер должно уехать финальное значение поля. Шлём, только если сумма или
      // комментарий реально изменились - лишний PATCH переписывал бы запись без нужды.
      const priceChanged = !!editBaseline && (
        editBaseline.actualPrice !== (el('bkActualPrice')?.value ?? '').trim() ||
        editBaseline.comment !== (el('bkStaffComment')?.value ?? '').trim()
      );
      if (priceChanged && typeof window.saveBookingActualPrice === 'function') {
        const priceOut = await window.saveBookingActualPrice();
        if (!priceOut.ok) throw new Error(priceOut.error);
      }

      // Статус визита (правка 13.08.2026, вторая итерация - Влад: "изменения должны
      // вступать в силу только при нажатии на кнопку 'Сохранить изменения'"). Раньше
      // PATCH уходил сразу по клику радио (wireBookingStatusRadios), и здесь только
      // досылалось расхождение. Теперь клик по радио в сеть не ходит вовсе - статус
      // сохраняется ровно отсюда, наравне с услугами, переносом и суммой. Сравнение
      // идёт с РЕАЛЬНЫМ статусом записи (form.dataset.realStatus), а не со снимком:
      // снимок хранит id радио и служит только кнопке, а на сервер должно уехать
      // именно то, что в базе ещё не так.
      const prevStatus = form.dataset.realStatus || editBooking.status || 'planned';
      const wantedStatus = RADIO_ID_TO_STATUS[checkedStatusRadioId()];
      if (wantedStatus && wantedStatus !== prevStatus) {
        const str = await fetch(`${API}/bookings/${encodeURIComponent(bookingId)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ status: wantedStatus }),
        });
        if (!str.ok) throw Object.assign(new Error('статус визита'), { status: str.status, code: (await str.json().catch(() => null))?.error ?? null });
        form.dataset.realStatus = wantedStatus;
        editBooking.status = wantedStatus;
        // Счётчик неявок клиента сервер уже пересчитал - зеркалим его же арифметику,
        // чтобы баннер "у этого клиента N неявок" не врал до перезагрузки страницы.
        applyNoShowStreakAfterStatus(form, prevStatus, wantedStatus);
      }

      // Запись сохранена целиком - новая точка отсчёта для кнопки: она снова гаснет
      // до следующей правки.
      editBaseline = editStateSnapshot();
      // Одно слово на любой успешный результат (правка 13.08.2026, Влад: "оставь
      // только 'Сохранено', остальной текст убери"). Перечисление что именно уехало
      // ("Сохранено: услуги, сумма и комментарий - Алиовсад, 2026-08-13 11:15")
      // пересказывало карточку, которая и так на экране. Ветки "Изменений не было"
      // здесь больше нет: кнопка неактивна, пока в записи ничего не меняли
      // (updateSubmitState), нажать её без единой правки физически нельзя.
      resultEl.hidden = false;
      resultEl.className = 'wf-result wf-result--ok';
      reportSuccess(resultEl, 'Сохранено');
      renderLiveProof(staff); // перерисовать календарь: слот освободился/занялся
    } catch (err) {
      resultEl.hidden = false;
      resultEl.className = 'wf-result wf-result--err';
      reportError(resultEl, err, 'Не удалось сохранить');
    } finally {
      updateSubmitState();
      submitBtn.textContent = originalLabel;
    }
  }

  if (!submitBtn.dataset.wired) {
    submitBtn.dataset.wired = '1';
    submitBtn.addEventListener('click', async () => {
      if (selected.size === 0 || !currentMasterId) return;
      // Окно 55, Задача C - редактирование существующей записи идёт своим путём:
      // не POST /bookings (создало бы ВТОРУЮ запись вместо правки первой), а
      // PATCH /services + PATCH /reschedule по уже существующему id.
      if (editMode) return void (await submitEdit());
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
            master_not_accepting: 'этот сотрудник сейчас не принимает клиентов',
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
        reportError(resultEl, err, 'Не удалось сохранить');
      } finally {
        updateSubmitState();
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
        reportError(saleResultEl, 'Укажите название товара и сумму больше нуля');
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
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, code: (await res.json().catch(() => null))?.error ?? null });
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--ok';
        saleResultEl.textContent = `Продажа добавлена: ${itemName}, ${formatMoney(amount)}`;
        saleItemEl.value = '';
        saleAmountEl.value = '';
      } catch (err) {
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--err';
        reportError(saleResultEl, err, 'Не удалось сохранить продажу');
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

  // Окно 55, Задача C - точка входа для клика по СУЩЕСТВУЮЩЕЙ записи в календаре
  // (assets/crm-calendar.js, buildApptCard). Заменила openBooking() из
  // assets/mockup-crm.js: раньше клик открывал отдельную карточку #bd-1 только на
  // просмотр (все поля readonly, менялся один статус), теперь - ту же общую форму в
  // режиме редактирования. Глобальная функция, а не export, по той же причине, что у
  // двух соседок выше: карточки записей рисуются строкой HTML с onclick=, а
  // HTML-атрибут резолвится только через window (ограничение браузера).
  // hasEditUi=false - страницы без формы записи (crm-master.html: мастер записи не
  // создаёт и не правит, свою read-only панель визита ему рисует
  // assets/crm-master-booking.js, она и регистрирует openBookingEdit).
  if (hasEditUi) {
    window.openBookingEdit = (el) => {
      const d = el.dataset;
      // Подсветка выбранной карточки - тот же приём, что был у openBooking():
      // wireBookingDelete (crm-booking-status.js) после удаления убирает из DOM
      // именно .appt--selected, эту связь ломать нельзя.
      document.querySelectorAll('.appt--selected').forEach((n) => {
        if (n !== el) n.classList.remove('appt--selected');
      });
      el.classList.add('appt--selected');
      openForWalkin(d.masterId, d.master, {
        edit: true,
        date: d.date,
        startTime: d.startTime,
        clientName: d.client,
        clientPhone: d.phone,
        serviceIds: (d.serviceIds || '').split(',').filter(Boolean),
        booking: {
          id: d.id,
          date: d.date,
          startTime: d.startTime,
          serviceIds: (d.serviceIds || '').split(',').filter(Boolean),
          status: d.realStatus || 'planned',
          noShowStreak: parseInt(d.noshowStreak, 10) || 0,
          requiresPrepayment: d.requiresPrepayment === 'true',
          actualPrice: d.actualPrice ? Number(d.actualPrice) : null,
          // Комментарий к записи (13.08.2026) - едет с карточки календаря тем же
          // приёмом, что и actualPrice: поле уже приходит с /bookings, отдельный
          // запрос за той же бронью не нужен.
          staffComment: d.staffComment || '',
        },
      });
    };
  }
}
