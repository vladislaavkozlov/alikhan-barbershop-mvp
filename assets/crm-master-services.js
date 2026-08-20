// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Редактор услуг/цен/длительности
// мастера в карточке "Сотрудники" (crm-owner.html), read-only для остальных
// ролей. Код перенесён 1в1, поведение не менялось.
import { formatMoney } from './crm-shared.js';
import { API, getToken } from './crm-auth.js';
import { sortByServiceOrder, SERVICE_COMBOS, SERVICES } from '../storage.js';

// Правка 03.08.2026: карточка сотрудника "Сотрудники" (владелец/админ) держала
// чекбоксы услуг мастера и поле длительности как чистую декорацию - ни одного
// fetch, "включено"/"выключено" не переживало перезагрузку страницы, хотя
// master_services в базе уже поддерживала это с самого Окна 8 (см. отчёт сессии
// 03.08.2026). Контейнер должен быть <div class="service-picker" data-master-id="…">
// (пустой, без статичных чекбоксов - их рисует эта функция). Только владелец
// реально включает/выключает услугу и меняет длительность (`canEdit`) -
// администратор/просмотр видят то же самое read-only, тот же уровень доступа, что
// уже есть у wireMasterSelfDataTab для самого мастера.
// 13.08.2026 - гонка двух рендереров одних и тех же чекбоксов: renderTeam
// (crm-team.js) рисует их с учётом "принимает клиентов", а эта функция вызывается
// из renderLiveProof и перерисовывала их заново, зная только роль зрителя - и
// возвращала услуги снятого с приёма в редактируемое состояние. Кто отработал
// последним, тот и определял результат. Признак берём из карточки, в которой лежит
// контейнер (data-provides-services ставит renderTeam) - один источник правды на
// обоих путях, вместо второго набора данных здесь.
// Роль управляющего появилась позже этой функции, а она осталась с проверкой
// "только владелец" - под управляющим услуги были недоступны у ВСЕХ сотрудников,
// хотя карточка команды их разрешала, а PUT /master-services/:masterId/:serviceId
// на сервере открыт роли management (owner+manager). Живой repro Влада 13.08.2026:
// зашёл управляющим, галки на месте, а услуги не меняются.
export function wireMasterServiceEditors(staffRole, services, masterServices) {
  const canEdit = staffRole === 'owner' || staffRole === 'manager';
  document.querySelectorAll('.service-picker[data-master-id]').forEach((container) => {
    const offDuty = container.closest('[data-provides-services="0"]') != null;
    // Карточку защищённого владельца управляющий не редактирует - renderTeam помечает
    // её data-locked-owner, здесь читаем ту же метку, чтобы оба пути совпадали
    const lockedOwner = container.closest('[data-locked-owner]') != null;
    renderMasterServiceEditor(container, container.dataset.masterId, canEdit && !offDuty && !lockedOwner, services, masterServices, () => {
      container.closest('.team-editor-card')?.dispatchEvent(new CustomEvent('crm:card-dirty', { bubbles: true }));
    });
  });
}

function clearDurationError(durationInput) {
  clearFieldError(durationInput);
}

// Подсветка снимается сразу, как только введено корректное значение - держать красным
// поле, которое владелец уже исправил, значит спорить с ним. Одна функция на цену и
// длительность: правила подсветки у них общие, расходиться им незачем.
function clearFieldError(field) {
  field.classList.remove('is-invalid');
  field.removeAttribute('aria-invalid');
}

export function renderMasterServiceEditor(container, masterId, canEdit, services, masterServices, onChange) {
  // Имена из живого каталога сервера - для подсказки о связанных ценах (comboPriceHint)
  serviceNamesById = Object.fromEntries(services.map((s) => [s.id, s.name]));
  container.innerHTML = '';
  container.classList.toggle('readonly', !canEdit);
  const assigned = new Map(masterServices.filter((r) => r.masterId === masterId).map((r) => [r.serviceId, r]));
  const note = document.createElement('p');
  note.className = 'section-hint';
  note.hidden = true;

  // Единый порядок показа услуг (storage.js SERVICE_ORDER) - каталог приезжает из
  // /services, но фронт и бэкенд деплоятся раздельно
  for (const service of sortByServiceOrder(services)) {
    const row = assigned.get(service.id);
    const label = document.createElement('label');
    label.className = 'service-check';
    // Исходное состояние строки: по нему saveServiceChanges понимает, что реально
    // изменили, и отправляет только эти услуги (13.08.2026 - услуги уехали под общую
    // кнопку "Сохранить изменения" вместе с остальной карточкой)
    label.dataset.serviceId = service.id;
    label.dataset.initialEnabled = row ? '1' : '0';
    label.dataset.initialDuration = String(row ? row.durationMin : service.durationMin);
    label.dataset.initialPrice = String(row ? row.price : service.price);
    label.dataset.initialTop = row?.isTop ? '1' : '0';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(row);
    input.disabled = !canEdit;

    const span = document.createElement('span');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'sc-name';
    nameSpan.textContent = service.name;
    const meta = document.createElement('span');
    meta.className = 'sc-meta';
    // Цена мастера (20.08.2026) - поле, а не текст. master_services.price различает
    // прайс по мастеру с Окна 8, но в карточке он был подписью: владелец видел, что
    // Елизавета дешевле, и не мог этого изменить, не идя в базу.
    const priceSpan = document.createElement('span');
    priceSpan.className = 'sc-price';
    const priceInput = document.createElement('input');
    priceInput.type = 'text';
    // inputMode вместо type="number": «3 000» с пробелом-разделителем из прайса
    // числовое поле не принимает вовсе, а владелец копирует цены именно так
    priceInput.inputMode = 'numeric';
    priceInput.className = 'sc-price-input';
    priceInput.value = row ? row.price : service.price;
    priceInput.disabled = !canEdit || !row;
    priceInput.setAttribute('aria-label', `Цена услуги «${service.name}»`);
    priceInput.addEventListener('click', (e) => e.stopPropagation());
    const priceUnit = document.createElement('span');
    priceUnit.className = 'sc-price-unit';
    priceUnit.textContent = '₽';
    priceSpan.append(priceInput, priceUnit);
    const dot = document.createElement('span');
    dot.className = 'sc-dot';
    dot.textContent = '·';
    const durationSpan = document.createElement('span');
    durationSpan.className = 'sc-duration';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '5';
    durationInput.step = '5';
    durationInput.className = 'sc-duration-input';
    durationInput.value = row ? row.durationMin : service.durationMin;
    durationInput.disabled = !canEdit || !row;
    durationInput.addEventListener('click', (e) => e.stopPropagation());
    const durationUnit = document.createElement('span');
    durationUnit.className = 'sc-duration-unit';
    durationUnit.textContent = 'мин';
    durationSpan.append(durationInput, durationUnit);
    // Галка «топ-услуга» (20.08.2026): по ней публичный сайт делит мастеров на два
    // тарифа. Живёт в той же строке, что цена, - владелец ставит галку и сразу рядом
    // видит (и правит) цифру, за которую эта топовость продаётся.
    const topLabel = document.createElement('label');
    topLabel.className = 'sc-top';
    const topInput = document.createElement('input');
    topInput.type = 'checkbox';
    topInput.className = 'sc-top-input';
    topInput.checked = Boolean(row?.isTop);
    topInput.disabled = !canEdit || !row;
    topInput.addEventListener('click', (e) => e.stopPropagation());
    const topText = document.createElement('span');
    topText.className = 'sc-top-text';
    topText.textContent = 'топ';
    topLabel.append(topInput, topText);
    topLabel.title = 'Топ-мастер по этой услуге - на сайте клиент выбирает его отдельным тарифом';
    meta.append(priceSpan, dot, durationSpan, topLabel);
    // Подсказка про связанную услугу (21.08.2026): комплекс и его части - связанные
    // цены, но система их не пересчитывает друг из друга (см. comboPriceHint), только
    // напоминает. Появляется после правки цены, а не висит всегда: на восьми услугах
    // это был бы шум, а нужна она ровно в момент, когда цифру трогают.
    const comboNote = document.createElement('span');
    comboNote.className = 'sc-combo-hint';
    comboNote.hidden = true;
    span.append(nameSpan, meta, comboNote);
    label.append(input, span);
    container.appendChild(label);

    if (!canEdit) continue;

    input.addEventListener('change', () => {
      durationInput.disabled = !input.checked;
      priceInput.disabled = !input.checked;
      // Снятая услуга не может оставаться топовой: тарифа без услуги не бывает, и
      // мёртвая включённая галка рядом с погасшими полями врала бы о состоянии
      topInput.disabled = !input.checked;
      if (!input.checked) {
        topInput.checked = false;
        clearDurationError(durationInput);
        clearFieldError(priceInput);
      }
      onChange?.();
    });
    for (const eventName of ['input', 'change']) {
      priceInput.addEventListener(eventName, () => {
        if (parsePriceValue(priceInput.value) != null) clearFieldError(priceInput);
        showComboHint(container, service.id, comboNote);
        onChange?.();
      });
    }
    topInput.addEventListener('change', () => onChange?.());
    // Подсветку снимаем сразу, как только введено корректное число - держать красным
    // поле, которое владелец уже исправил, значит спорить с ним
    durationInput.addEventListener('input', () => {
      if (parseDurationValue(durationInput.value) != null) clearDurationError(durationInput);
      onChange?.();
    });
    durationInput.addEventListener('change', () => {
      if (parseDurationValue(durationInput.value) != null) clearDurationError(durationInput);
      onChange?.();
    });
  }
  container.appendChild(note);
}

export const DURATION_ERROR = 'Длительность услуги должна быть больше 0 минут';

// Единственное место, где строка из поля превращается в минуты. Всё, что не целое
// положительное число (0, пусто, минус, "abc", 1.5), - null, то есть "введено
// неверно", а не "оставим как было": прежний `Number(value) || initial` молча
// подменял ноль исходными 60 минутами, из-за чего правка не считалась правкой,
// на сервер не уезжала и после F5 значение возвращалось к 60 без единой ошибки
// (баг P2, найден Владом 15.08.2026)
// Названия услуг для подсказки берём из каталога, а не из id: подсказка адресована
// владельцу, и «kompleks-strizhka-boroda» ему ни о чём не говорит. Каталог приезжает
// в renderMasterServiceEditor, поэтому имена кладём сюда при отрисовке строк.
let serviceNamesById = {};

// Комплекс и его составляющие - связанные цены, но НЕ вычисляемые друг из друга
// (21.08.2026, вопрос Влада «а комплекс не должен пересчитаться сам?»). Комплекс стоит
// 3500 при сумме частей 3600: внутри него скидка, которую придумал владелец, а правила
// «комплекс = сумма минус X» в системе нет и выдумывать его на боевом прайсе нельзя -
// это деньги клиента. Поэтому система не считает за человека, а напоминает: поменял
// часть - проверь комплекс, поменял комплекс - вот сколько те же услуги стоят порознь.
// null - подсказывать нечего (услуга вне комплексов или связанные услуги мастеру не
// назначены: цена, которой у него нет, в подсказке была бы выдумкой).
export function comboPriceHint(serviceId, priceByServiceId) {
  const money = (value) => `${value.toLocaleString('ru-RU')} ₽`;
  // Имя из живого каталога сервера, если он уже отрисован, иначе из storage.js -
  // подсказка не должна показывать владельцу «kompleks-strizhka-boroda»
  const nameOf = (id) => serviceNamesById[id] ?? SERVICES.find((s) => s.id === id)?.name ?? id;
  for (const combo of SERVICE_COMBOS) {
    const comboPrice = priceByServiceId[combo.comboId];
    if (serviceId === combo.comboId) {
      const parts = combo.mergeFrom.map((id) => priceByServiceId[id]);
      if (parts.some((price) => !Number.isFinite(price))) return null;
      const names = combo.mergeFrom.map((id) => `«${nameOf(id)}»`).join(' и ');
      return `Состоит из услуг ${names} - по отдельности сейчас ${money(parts.reduce((a, b) => a + b, 0))}`;
    }
    if (combo.mergeFrom.includes(serviceId)) {
      if (!Number.isFinite(comboPrice)) return null;
      return `Входит в «${nameOf(combo.comboId)}» - сейчас ${money(comboPrice)}, проверьте и его`;
    }
  }
  return null;
}

// Текущие цены всех строк карточки - то, что владелец видит на экране прямо сейчас
// (включая ещё не сохранённые правки): подсказка должна опираться на них, а не на
// значения с сервера, иначе она отставала бы на один шаг.
function currentPricesFrom(container) {
  const prices = {};
  container.querySelectorAll('.service-check[data-service-id]').forEach((row) => {
    const box = row.querySelector('input[type="checkbox"]');
    const field = row.querySelector('.sc-price-input');
    // Выключенная услуга в подсказку не идёт: её цена мастеру не назначена
    if (!box?.checked) return;
    const value = parsePriceValue(field?.value);
    if (value != null) prices[row.dataset.serviceId] = value;
  });
  return prices;
}

function showComboHint(container, serviceId, noteEl) {
  if (!noteEl) return;
  const text = comboPriceHint(serviceId, currentPricesFrom(container));
  noteEl.textContent = text ?? '';
  noteEl.hidden = !text;
}

export const PRICE_ERROR = 'Цена услуги должна быть целым числом больше нуля';

// Строка из поля цены в рубли. Пробелы внутри числа - не ошибка: владелец копирует
// «3 000» из своего прайса, и отбивать такое значило бы спорить с человеком на ровном
// месте. Всё остальное, что не целое положительное (0, пусто, минус, дробь, буквы), -
// null, то есть «введено неверно», а не «оставим как было»: ровно тот же урок, что дал
// баг P2 с длительностью 15.08.2026, только про деньги.
export function parsePriceValue(raw) {
  const text = String(raw ?? '').replace(/[\s\u00a0]/g, '');
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

export function parseDurationValue(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

// Что в этом блоке отличается от загруженного с сервера. Пустой массив = сохранять
// нечего, поэтому кнопка карточки остаётся неактивной. Неверная длительность тоже
// попадает сюда (durationMin: null) - кнопка обязана остаться живой, иначе владелец
// не увидит, что именно не так; отсекает такую строку markInvalidServiceDurations
// перед отправкой.
export function collectServiceChanges(container) {
  if (!container) return [];
  const changes = [];
  container.querySelectorAll('.service-check[data-service-id]').forEach((label) => {
    const input = label.querySelector('input[type="checkbox"]');
    const durationInput = label.querySelector('.sc-duration-input');
    const priceInput = label.querySelector('.sc-price-input');
    const topInput = label.querySelector('.sc-top-input');
    const enabled = Boolean(input?.checked);
    const duration = parseDurationValue(durationInput?.value);
    const price = parsePriceValue(priceInput?.value);
    // Тариф без услуги существовать не может: у выключенной строки топ всегда false,
    // на сервер уедет { enabled: false } и строка master_services исчезнет целиком
    const isTop = enabled && Boolean(topInput?.checked);
    const wasEnabled = label.dataset.initialEnabled === '1';
    const wasDuration = Number(label.dataset.initialDuration);
    const wasPrice = Number(label.dataset.initialPrice);
    const wasTop = label.dataset.initialTop === '1';
    const untouched = enabled === wasEnabled && (!enabled || (duration === wasDuration && price === wasPrice && isTop === wasTop));
    if (untouched) return;
    changes.push({ serviceId: label.dataset.serviceId, enabled, durationMin: duration, price, isTop });
  });
  return changes;
}

// Подсвечивает строки включённых услуг с неверной длительностью и возвращает их
// serviceId. Пустой массив = сохранять можно. Выключенная услуга не проверяется -
// её длительность на сервер не уезжает вовсе (тело запроса { enabled: false }).
export function markInvalidServiceDurations(container) {
  if (!container) return [];
  const invalid = [];
  container.querySelectorAll('.service-check[data-service-id]').forEach((label) => {
    const input = label.querySelector('input[type="checkbox"]');
    const durationInput = label.querySelector('.sc-duration-input');
    if (!durationInput) return;
    const bad = Boolean(input?.checked) && parseDurationValue(durationInput.value) == null;
    durationInput.classList.toggle('is-invalid', bad);
    if (bad) {
      durationInput.setAttribute('aria-invalid', 'true');
      invalid.push(label.dataset.serviceId);
    } else {
      durationInput.removeAttribute('aria-invalid');
    }
  });
  return invalid;
}

// То же самое для цены. Выключенная услуга не проверяется - её цена на сервер не
// уезжает вовсе (тело запроса { enabled: false }).
export function markInvalidServicePrices(container) {
  if (!container) return [];
  const invalid = [];
  container.querySelectorAll('.service-check[data-service-id]').forEach((label) => {
    const input = label.querySelector('input[type="checkbox"]');
    const priceInput = label.querySelector('.sc-price-input');
    if (!priceInput) return;
    const bad = Boolean(input?.checked) && parsePriceValue(priceInput.value) == null;
    priceInput.classList.toggle('is-invalid', bad);
    if (bad) {
      priceInput.setAttribute('aria-invalid', 'true');
      invalid.push(label.dataset.serviceId);
    } else {
      priceInput.removeAttribute('aria-invalid');
    }
  });
  return invalid;
}

// Отправляет только изменённые услуги. Возвращает null при успехе, иначе описание
// первой не сохранившейся услуги ({ serviceId, status, data }) - карточка покажет по
// нему причину отказа, а не просто «не получилось» (правка Влада 15.08.2026).
export async function saveServiceChanges(masterId, changes) {
  for (const change of changes) {
    // Страховка на случай, если валидацию когда-нибудь обойдут мимо кнопки карточки:
    // null-длительность на сервере молча подменилась бы каталожной, а владелец увидел
    // бы "Сохранено" с чужой цифрой
    if (change.enabled && parseDurationValue(change.durationMin) == null) {
      return { serviceId: change.serviceId, status: 400, data: { error: 'invalid_duration' } };
    }
    // Та же страховка для цены: null на сервере молча подменился бы каталожной ценой,
    // и владелец увидел бы «Сохранено» с чужой цифрой в собственном прайсе
    if (change.enabled && parsePriceValue(change.price) == null) {
      return { serviceId: change.serviceId, status: 400, data: { error: 'invalid_price' } };
    }
    // Все поля строки разом: роут переписывает строку master_services целиком
    // (ON CONFLICT DO UPDATE), и непереданная цена вернулась бы к каталожной, а
    // непереданная галка - к «не топ», то есть правка одного поля стирала бы соседние
    const body = change.enabled
      ? { enabled: true, durationMin: change.durationMin, price: change.price, isTop: change.isTop }
      : { enabled: false };
    const res = await fetch(`${API}/master-services/${encodeURIComponent(masterId)}/${encodeURIComponent(change.serviceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return { serviceId: change.serviceId, status: res.status, data };
    }
  }
  return null;
}
