const STORAGE_KEY = 'alikhan-mvp:bookings:v1';

// Реальные имена мастеров, названы Владом 01.08.2026 (после блока про 1 точку в том
// же разговоре) - "Иван 1"/"Иван 2" никогда не были даже примерным попаданием.
// master-3 переименовывалась трижды: сначала в "Елизавета" (Алихан, 30.07.2026,
// разд.17.1 ТЗ - см. api/migrations/006_master3_rename.sql), затем в тот же день
// (01.08.2026) на "Екатерина" (миграция 011_real_master_names.sql) - но это
// оказалось ошибкой Влада, 03.08.2026 он вернул обратно на "Елизавета" (миграция
// 018_master3_rename_elizaveta.sql). Алиовсад - реальный владелец, не просто мастер (в
// базе staff.role = 'owner', см. ту же миграцию). По просьбе Влада здесь полное имя,
// не короткое "Али" - без пробела/скобки, поэтому renderMasters() в app.js
// (аватар берёт первую букву КАЖДОГО слова через split(' ')) не ломается. isPlaceholder
// оставлен true у всех троих: фото/телефоны/email всё ещё демо-заглушки, точны
// только имена.
export const MASTERS = [
  { id: 'master-1', name: 'Алиовсад', isPlaceholder: true, workWindow: { start: '10:00', end: '20:00' } },
  { id: 'master-2', name: 'Мамедхан', isPlaceholder: true, workWindow: { start: '10:00', end: '20:00' } },
  { id: 'master-3', name: 'Елизавета', isPlaceholder: true, workWindow: { start: '10:00', end: '20:00' } },
];

export const SERVICES = [
  {
    id: 'strizhka',
    name: 'Стрижка',
    durationLabel: '1 час',
    durationMin: 60,
    priceLabel: '2000₽',
    price: 2000,
    composition:
      'Консультация по подбору стрижки по форме лица и структуре волос, профессиональное выполнение, мытьё головы, одеколон/бальзам, расслабляющий массаж головы и шейно-воротниковой зоны, укладка проф. средствами',
  },
  {
    id: 'boroda',
    name: 'Борода',
    durationLabel: '30 мин',
    durationMin: 30,
    priceLabel: '1600₽',
    price: 1600,
    composition:
      'Консультация и подбор по форме лица, окантовка с бритвой, укладка проф. средствами, расслабляющий массаж головы и шейно-воротниковой зоны',
  },
  {
    id: 'kompleks-strizhka-boroda',
    name: 'Комплекс стрижка+борода',
    durationLabel: '1 час',
    durationMin: 60,
    priceLabel: '3500₽',
    price: 3500,
    composition: 'Объединяет обе услуги выше',
  },
  {
    id: 'britie',
    name: 'Бритьё',
    durationLabel: '30-40 мин',
    durationMin: 40,
    priceLabel: '1500₽',
    price: 1500,
    composition: 'Сухое бритьё электробритвой головы или бороды, мытьё головы или лица',
  },
  {
    id: 'firmennaya-okantovka',
    name: 'Фирменная окантовка',
    durationLabel: '30 мин',
    durationMin: 30,
    priceLabel: '1400₽',
    price: 1400,
    composition: 'Стрижка под одну насадку или окантовка волос и бороды, мытьё головы',
  },
  {
    id: 'tonirovka',
    name: 'Тонировка седых волос',
    durationLabel: '1 час',
    durationMin: 60,
    priceLabel: 'от 1500₽',
    price: 1500,
    composition: 'Консультация и подбор цвета, мытьё зоны тонировки',
  },
  {
    id: 'vosk',
    name: 'Воск',
    durationLabel: '10-15 мин',
    durationMin: 15,
    priceLabel: 'от 500₽',
    price: 500,
    composition: 'Удаление нежелательных волос горячим воском (уши, нос, лицо)',
  },
  {
    id: 'spa-uhod',
    name: 'СПА уход',
    durationLabel: '1 час',
    durationMin: 60,
    priceLabel: '3000₽',
    price: 3000,
    composition:
      'Профессиональная косметика, распаривание лица, скрабирование кожи, чёрная маска против чёрных точек, патчи, гидрогелевая маска, мытьё лица',
  },
];

// Цена по мастеру (Окно 10, 30.07.2026, разд.17.2 ТЗ) - Елизавета дешевле
// Алиовсад/Мамедхана на большинстве услуг, "СПА уход" Алихан не называл, не выдумываем,
// остаётся общей ценой. Дублирует master_services в БД (см.
// api/migrations/004_master_prices.sql) - публичный сайт не ходит в API за
// прайсом (тот же оффлайн-совместимый паттерн, что уже был у SERVICES/MASTERS
// здесь до Окна 10), поэтому цифры здесь синхронизируются вручную, не фетчем.
const MASTER_SERVICE_PRICES = {
  'master-3': {
    strizhka: 1500,
    boroda: 1200,
    'kompleks-strizhka-boroda': 2500,
    'firmennaya-okantovka': 1000,
    britie: 1000,
    tonirovka: 1200,
  },
};

// Цена конкретного мастера на услугу - override из MASTER_SERVICE_PRICES, иначе
// общая цена услуги (findService объявлена ниже в файле, но доступна здесь по
// hoisting - обе function-декларации в одном модуле).
export function priceForMaster(masterId, serviceId) {
  const override = MASTER_SERVICE_PRICES[masterId]?.[serviceId];
  return override ?? findService(serviceId).price;
}

// Тот же формат, что и service.priceLabel ("2000₽" / "от 1500₽") - сохраняет
// префикс "от", если он был у базовой услуги.
export function priceLabelForMaster(masterId, serviceId) {
  const service = findService(serviceId);
  const price = priceForMaster(masterId, serviceId);
  const prefix = service.priceLabel.trim().startsWith('от') ? 'от ' : '';
  return `${prefix}${price}₽`;
}

function toMinutes(value) {
  if (typeof value === 'number') return value;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  const aS = toMinutes(aStart);
  const aE = toMinutes(aEnd);
  const bS = toMinutes(bStart);
  const bE = toMinutes(bEnd);
  return aS < bE && bS < aE;
}

export function defaultBackend() {
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    return globalThis.localStorage;
  }
  throw new Error('storage.js: нет доступного storage-бэкенда, передайте его явно (напр. in-memory в тестах)');
}

// Бэкенд поверх реального API (Amvera + Postgres) вместо localStorage - REST-методы
// ниже (listBookings/createBooking и т.д.), не общий getItem/setItem-контракт: тот
// был снят вместе с /kv/:key роутами (Окно 33, мёртвый код против прод-трафика,
// isRichBackend в createStore ниже всегда обходит его на этом бэкенде).
//
// getToken - необязательная функция () => string|null. Если задана, её текущее
// значение уходит в заголовке Authorization на каждый запрос - так вызывающий код
// (admin.js после логина) может подставлять свежий токен, не пересоздавая бэкенд.
// Без неё (или пока не залогинен) запросы анонимные - ровно то, что нужно
// публичному виджету записи клиента (index.html): сервер сам решает, какие поля
// отдавать анонимному запросу (Окно 8, роли на бэкенде).
export function createHttpBackend(apiBaseUrl, getToken) {
  function authHeaders() {
    const token = typeof getToken === 'function' ? getToken() : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  return {
    // ── Окно 8: бронирования поверх нормализованной схемы, не kv-блока ──────
    // Присутствие этого метода на бэкенде - переключатель для createStore ниже:
    // если он есть, createBooking/listBookings идут через REST
    // (сервер сам считает пересечения и решает, какие поля клиента отдавать по роли),
    // если нет (localStorage/in-memory бэкенды в тестах) - используется старая логика
    // на JSON-блоке без изменений.
    async listBookings({ date, masterId } = {}) {
      const params = new URLSearchParams();
      if (date) params.set('date', date);
      if (masterId) params.set('masterId', masterId);
      const res = await fetch(`${apiBaseUrl}/bookings?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`storage.js: GET /bookings → ${res.status}`);
      const data = await res.json();
      return data.bookings;
    },
    // Окно 11: serviceIds - массив (1+), не единичный serviceId. Сервер сам считает
    // сумму длительности/цены по всем услугам этого мастера (master_services).
    async createBooking({ masterId, serviceIds, date, startTime, clientName, clientPhone }) {
      const res = await fetch(`${apiBaseUrl}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ masterId, serviceIds, date, startTime, clientName, clientPhone }),
      });
      if (res.status === 409) {
        // Раньше любой 409 подписывался как 'overlap' независимо от настоящей
        // причины (schedule_blocked/past_time от сервера тоже приходили сюда) -
        // теперь берём реальный reason из тела ответа, app.js показывает разный текст.
        const data = await res.json().catch(() => ({}));
        return { ok: false, reason: data.reason || 'overlap' };
      }
      if (!res.ok) throw new Error(`storage.js: POST /bookings → ${res.status}`);
      return res.json();
    },
    // Баг Влада (02.08.2026): публичный виджет не знал про реальные перерывы
    // мастера - GET /schedule теперь разрешён анонимно с обязательными masterId+date
    // (api/server.mjs). Без токена (публичный сайт) authHeaders() просто вернёт {}.
    async getSchedule({ masterId, date }) {
      const params = new URLSearchParams({ masterId, date });
      const res = await fetch(`${apiBaseUrl}/schedule?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`storage.js: GET /schedule → ${res.status}`);
      return res.json();
    },
  };
}

export function getMasters() {
  return MASTERS;
}

export async function loadPublicMasters(apiBaseUrl) {
  const res = await fetch(`${apiBaseUrl}/public/masters`);
  if (!res.ok) throw new Error(`storage.js: GET /public/masters → ${res.status}`);
  return res.json();
}

// Задача C промпта Окна 29 (05.08.2026) - мастер без единого рабочего дня в
// стандартном графике не должен быть виден в списке выбора клиента (бэкенд остаётся
// финальным рубежом - см. master_not_bookable в api/server.mjs createBookingTx, это
// первая линия UX, не защита). hasWorkingScheduleByMasterId=null - ответ
// /masters-next-availability ещё не пришёл (или офлайн-демо без ALIKHAN_API_URL) -
// ничего не фильтруем, виджет не ломается (тот же принцип, что уже применён к
// masterAvailabilityReady в app.js). Мастер, которого нет в карте вовсе (например
// нет ни одной услуги в master_services - другая, не эта, причина небронируемости) -
// тоже не трогаем, значение по умолчанию "показан", чтобы не смешивать два разных
// условия в одном фильтре.
export function filterBookableMasters(masterList, hasWorkingScheduleByMasterId) {
  if (!hasWorkingScheduleByMasterId) return masterList;
  return masterList.filter((m) => hasWorkingScheduleByMasterId.get(m.id) !== false);
}

export function getServices() {
  return SERVICES;
}

// Правки Влада 03.08.2026: комплекс "стрижка+борода" уже включает эти 4 услуги по
// смыслу (окантовка и бритьё - часть той же техники), поэтому отдельно их рядом с
// комплексом выбрать нельзя, а отдельный выбор "стрижка"+"борода" сам должен
// превращаться в комплекс. Один список правил, не два места с одной и той же
// логикой - используется и публичной записью (app.js), и формой мастера (wireWalkIn
// в crm-auth.js), оба уже импортируют storage.js.
export const SERVICE_COMBOS = [
  {
    comboId: 'kompleks-strizhka-boroda',
    mergeFrom: ['strizhka', 'boroda'],
    blocks: ['strizhka', 'boroda', 'britie', 'firmennaya-okantovka'],
  },
];

// Если сейчас отдельно отмечены обе услуги-компонента комбо (например
// "стрижка"+"борода") - заменяет их одной услугой комбо. Возвращает НОВЫЙ Set,
// исходный не мутирует (вызывающий код сам решает, обновлять ли своё состояние).
export function mergeServiceCombos(selectedIds) {
  let result = new Set(selectedIds);
  for (const combo of SERVICE_COMBOS) {
    if (combo.mergeFrom.every((id) => result.has(id))) {
      result = new Set(result);
      combo.mergeFrom.forEach((id) => result.delete(id));
      result.add(combo.comboId);
    }
  }
  return result;
}

// true, если serviceId нельзя отметить прямо сейчас, потому что уже выбран комбо,
// который его перекрывает (используется, чтобы отрисовать чекбокс/кнопку disabled).
export function isServiceBlockedByCombo(serviceId, selectedIds) {
  return SERVICE_COMBOS.some((combo) => selectedIds.has(combo.comboId) && combo.blocks.includes(serviceId));
}

function findMaster(masterId) {
  const master = MASTERS.find((m) => m.id === masterId);
  if (!master) throw new Error(`Неизвестный masterId: ${masterId}`);
  return master;
}

function findService(serviceId) {
  const service = SERVICES.find((s) => s.id === serviceId);
  if (!service) throw new Error(`Неизвестный serviceId: ${serviceId}`);
  return service;
}

function parseBookings(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function readBookings(backend) {
  const raw = await backend.getItem(STORAGE_KEY);
  return parseBookings(raw);
}

// Compare-and-swap: пишет, только если текущее значение в хранилище всё ещё равно
// тому, что было прочитано непосредственно перед этим - если кто-то другой (другая
// вкладка/устройство) успел записать между чтением и записью, возвращает false и
// вызывающий код должен перечитать заново, а не молча затирать чужую запись.
// localStorage/in-memory бэкенды в тестах casSetItem не реализуют - им синтезируется
// дефолтная реализация ниже (для одного JS-потока этого достаточно), у сетевого
// бэкенда (createHttpBackend) - настоящая атомарная проверка на стороне Postgres.
async function casWriteBookings(backend, expectedRaw, bookings) {
  const newRaw = JSON.stringify(bookings);
  if (typeof backend.casSetItem === 'function') {
    return backend.casSetItem(STORAGE_KEY, expectedRaw ?? null, newRaw);
  }
  const current = await backend.getItem(STORAGE_KEY);
  if ((current ?? null) !== (expectedRaw ?? null)) return false;
  await backend.setItem(STORAGE_KEY, newRaw);
  return true;
}

export function createStore(backend = defaultBackend()) {
  // Локальная сериализация записи в пределах ОДНОГО процесса/вкладки (например два
  // быстрых клика подряд в одном браузере). CAS ниже защищает от гонки МЕЖДУ разными
  // процессами (два устройства бьют по одному сетевому бэкенду) - там локальной
  // очереди нет и быть не может, оттуда и нужен retry-цикл поверх неё. Без этой
  // локальной очереди два параллельных вызова createBooking в одном и том же сторе
  // читают состояние ДО того как другой успел записать, и CAS-проверка (тоже
  // основанная на чтении, отдельным сетевым/асинхронным вызовом) не успевает
  // заметить чужую запись - оба проходят compare-and-swap с одним и тем же
  // "старым" ожидаемым значением.
  let writeQueue = Promise.resolve();
  function serialized(fn) {
    const run = writeQueue.then(fn, fn);
    writeQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // Богатый HTTP-бэкенд (createHttpBackend, Окно 8) сам знает, что отдавать по роли
  // и как фильтровать по дате/мастеру на сервере - используем его метод напрямую.
  // localStorage/in-memory бэкенды (тесты, Окна 1-7) такого метода не имеют -
  // работает старая логика на JSON-блоке без единого изменения.
  const isRichBackend = typeof backend.createBooking === 'function' && typeof backend.listBookings === 'function';

  async function listBookings({ date, masterId } = {}) {
    if (isRichBackend) return backend.listBookings({ date, masterId });
    const all = await readBookings(backend);
    return all.filter((b) => (date ? b.date === date : true) && (masterId ? b.masterId === masterId : true));
  }

  // Баг Влада (02.08.2026): getFreeSlots считала свободное время только по
  // фиксированному окну 10:00-20:00 и существующим броням - реальные перерывы
  // мастера (schedule_breaks) вообще не проверялись, сервер их знает и отклоняет
  // бронь (schedule_blocked, server.mjs createBookingTx), но виджет всё равно
  // показывал такие слоты кликабельными. Локальный (не rich) бэкенд не умеет
  // getSchedule - тестовый/офлайн режим просто не фильтрует по перерывам, overlap-
  // проверка на сервере (когда он есть) всё равно последний рубеж защиты.
  // Правка 03.08.2026 (Окно 16): раньше отсюда читались только breaks - рабочее окно
  // всегда бралось из статичного master.workWindow (10:00-20:00 захардкожено в
  // MASTERS выше). Теперь мастер может иметь свои часы на каждый день недели
  // (master_weekly_schedule, GET /schedule уже отдаёт актуальные startTime/endTime) -
  // окно тоже нужно брать оттуда, иначе виджет предложит слоты, которые сервер
  // отклонит как schedule_blocked (createBookingTx теперь проверяет и границы окна).
  async function getEffectiveWindowFor(masterId, dateStr) {
    const master = findMaster(masterId);
    const fallback = { startTime: master.workWindow.start, endTime: master.workWindow.end, breaks: [] };
    if (typeof backend.getSchedule !== 'function') return fallback;
    try {
      const shifts = await backend.getSchedule({ masterId, date: dateStr });
      const shift = shifts.find((s) => s.date === dateStr);
      if (!shift) return fallback;
      return { startTime: shift.startTime || fallback.startTime, endTime: shift.endTime || fallback.endTime, breaks: shift.breaks ?? [] };
    } catch {
      return fallback; // не блокируем виджет, если график не удалось получить
    }
  }

  async function getFreeSlots(masterId, dateStr, serviceDurationMin, stepMin = 15) {
    const [existing, { startTime: winStart, endTime: winEnd, breaks }] = await Promise.all([
      listBookings({ date: dateStr, masterId }),
      getEffectiveWindowFor(masterId, dateStr),
    ]);
    const windowStart = toMinutes(winStart);
    const windowEnd = toMinutes(winEnd);

    // Тот же баг: 10:00 предлагался как свободный слот, даже когда на часах уже
    // 13:38 сегодня же. dateStr - "YYYY-MM-DD" в местном времени барбершопа,
    // сравниваем с локальным временем БРАУЗЕРА клиента - для реальных посетителей
    // из Ставрополя это то же самое время, никакого отдельного пересчёта пояса не
    // нужно (в отличие от сервера, чей часовой пояс не гарантирован).
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const nowMinutes = dateStr === todayStr ? now.getHours() * 60 + now.getMinutes() : -1;

    const slots = [];
    for (let start = windowStart; start + serviceDurationMin <= windowEnd; start += stepMin) {
      if (start <= nowMinutes) continue;
      const end = start + serviceDurationMin;
      // Отменённая бронь (status:'cancelled') раньше тоже считалась занятостью -
      // найдено при проверке этого же фикса: тестовая отменённая бронь навсегда
      // блокировала своё время. Сервер (server.mjs createBookingTx) уже исключает
      // cancelled из своей проверки пересечений - здесь та же логика, для симметрии.
      const overlapsExisting = existing.some((b) => b.status !== 'cancelled' && intervalsOverlap(start, end, b.startTime, b.endTime));
      const overlapsBreak = breaks.some((b) => intervalsOverlap(start, end, b.startTime, b.endTime));
      if (!overlapsExisting && !overlapsBreak) {
        slots.push(minutesToTime(start));
      }
    }
    return slots;
  }

  // Окно 11: клиент выбирает НЕСКОЛЬКО услуг за визит - serviceId (единичный) всё
  // ещё принимается для обратной совместимости (заворачивается в массив из одного),
  // но актуальный контракт - serviceIds (массив, 1+). Длительность слота - сумма
  // длительностей всех услуг.
  async function createBooking({ masterId, serviceId, serviceIds, date, startTime, clientName, clientPhone }) {
    const ids = serviceIds ?? (serviceId ? [serviceId] : []);
    if (isRichBackend) {
      // CAS/пересечение слотов теперь проверяет и гарантирует сервер (pg_advisory_xact_lock
      // на паре мастер+дата в server.mjs) - тот же принцип, что был в CAS поверх kv_store,
      // просто перенесён на сторону базы вместе со схемой. Локальная serialized()-очередь
      // здесь не нужна: нет общего JSON-блока, который можно было бы гонкой затереть.
      return backend.createBooking({ masterId, serviceIds: ids, date, startTime, clientName, clientPhone });
    }
    return serialized(async () => {
      const servicesChosen = ids.map(findService);
      const totalDuration = servicesChosen.reduce((sum, s) => sum + s.durationMin, 0);
      const endTime = minutesToTime(toMinutes(startTime) + totalDuration);

      // Проверка занятости и запись должны быть атомарны относительно других
      // параллельных попыток - иначе два устройства могут оба прочитать "свободно"
      // и оба записать, второй затерев первого. Локальные гонки (тот же процесс/
      // вкладка) закрывает serialized() выше, кросс-процессные (два устройства бьют
      // по одному сетевому бэкенду) - вот этот retry-цикл поверх CAS: пишем, только
      // если хранилище не изменилось с момента чтения, иначе перечитываем и
      // проверяем занятость заново, с ограничением попыток (PM, 24.07.2026 →
      // пересмотрено 27.07.2026 при переходе на сетевой бэкенд).
      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = await backend.getItem(STORAGE_KEY);
        const all = parseBookings(raw);
        const sameMasterSameDay = all.filter((b) => b.masterId === masterId && b.date === date);
        const hasOverlap = sameMasterSameDay.some((b) => intervalsOverlap(startTime, endTime, b.startTime, b.endTime));
        if (hasOverlap) {
          return { ok: false, reason: 'overlap' };
        }

        const booking = {
          id: `${date}-${startTime}-${masterId}-${Math.random().toString(36).slice(2, 9)}`,
          masterId,
          serviceId: ids[0], // обратная совместимость - первая услуга
          serviceIds: ids,
          date,
          startTime,
          endTime,
          clientName,
          clientPhone,
          createdAt: new Date().toISOString(),
        };
        const written = await casWriteBookings(backend, raw, [...all, booking]);
        if (written) return { ok: true, booking };
        // кто-то другой записал между нашим чтением и записью - перечитываем и пробуем снова
      }
      return { ok: false, reason: 'conflict' };
    });
  }

  return { listBookings, getFreeSlots, createBooking };
}
