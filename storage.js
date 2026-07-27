const STORAGE_KEY = 'alikhan-mvp:bookings:v1';

export const MASTERS = [
  { id: 'master-1', name: 'Иван 1', isPlaceholder: true, workWindow: { start: '10:00', end: '20:00' } },
  { id: 'master-2', name: 'Иван 2', isPlaceholder: true, workWindow: { start: '10:00', end: '20:00' } },
  { id: 'master-3', name: 'Иван 3', isPlaceholder: true, workWindow: { start: '10:00', end: '20:00' } },
];

export const SERVICES = [
  {
    id: 'strizhka',
    name: 'Стрижка',
    durationLabel: '30-40 мин',
    durationMin: 40,
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

// Бэкенд поверх реального API (Amvera + Postgres) вместо localStorage - тот же
// getItem/setItem-контракт, но по сети. Все вызовы createStore() уже await'ят
// backend.getItem/setItem, поэтому localStorage (синхронный) и этот (асинхронный)
// бэкенды взаимозаменяемы без изменений в остальном коде.
export function createHttpBackend(apiBaseUrl) {
  return {
    async getItem(key) {
      const res = await fetch(`${apiBaseUrl}/kv/${encodeURIComponent(key)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage.js: GET /kv/${key} → ${res.status}`);
      const data = await res.json();
      return data.value;
    },
    async setItem(key, value) {
      const res = await fetch(`${apiBaseUrl}/kv/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: String(value) }),
      });
      if (!res.ok) throw new Error(`storage.js: PUT /kv/${key} → ${res.status}`);
    },
    // Атомарная запись на стороне сервера: API проверяет текущее значение в той же
    // транзакции, что и запись, поэтому гонка между двумя устройствами реально исключена
    // (не просто "два fetch подряд" из клиента, где между ними всегда есть окно гонки).
    async casSetItem(key, expected, value) {
      const res = await fetch(`${apiBaseUrl}/kv/${encodeURIComponent(key)}/cas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected: expected ?? null, value: String(value) }),
      });
      if (res.status === 409) return false;
      if (!res.ok) throw new Error(`storage.js: POST /kv/${key}/cas → ${res.status}`);
      return true;
    },
  };
}

export function getMasters() {
  return MASTERS;
}

export function getServices() {
  return SERVICES;
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

  async function listBookings({ date, masterId } = {}) {
    const all = await readBookings(backend);
    return all.filter((b) => (date ? b.date === date : true) && (masterId ? b.masterId === masterId : true));
  }

  async function getFreeSlots(masterId, dateStr, serviceDurationMin, stepMin = 15) {
    const master = findMaster(masterId);
    const windowStart = toMinutes(master.workWindow.start);
    const windowEnd = toMinutes(master.workWindow.end);
    const existing = await listBookings({ date: dateStr, masterId });

    const slots = [];
    for (let start = windowStart; start + serviceDurationMin <= windowEnd; start += stepMin) {
      const end = start + serviceDurationMin;
      const overlapsExisting = existing.some((b) => intervalsOverlap(start, end, b.startTime, b.endTime));
      if (!overlapsExisting) {
        slots.push(minutesToTime(start));
      }
    }
    return slots;
  }

  async function createBooking({ masterId, serviceId, date, startTime, clientName, clientPhone }) {
    return serialized(async () => {
      const service = findService(serviceId);
      const endTime = minutesToTime(toMinutes(startTime) + service.durationMin);

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
          serviceId,
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

  async function calcPayrollEstimate({ masterId, from, to } = {}) {
    const all = await readBookings(backend);
    const filtered = all.filter((b) => {
      if (masterId && b.masterId !== masterId) return false;
      if (from && b.date < from) return false;
      if (to && b.date > to) return false;
      return true;
    });
    const total = filtered.reduce((sum, b) => {
      const service = SERVICES.find((s) => s.id === b.serviceId);
      return sum + (service ? service.price : 0);
    }, 0);
    return { total, low: total * 0.45, high: total * 0.5 };
  }

  return { listBookings, getFreeSlots, createBooking, calcPayrollEstimate };
}
