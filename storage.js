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

function readBookings(backend) {
  const raw = backend.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBookings(backend, bookings) {
  backend.setItem(STORAGE_KEY, JSON.stringify(bookings));
}

export function createStore(backend = defaultBackend()) {
  function listBookings({ date, masterId } = {}) {
    return readBookings(backend).filter(
      (b) => (date ? b.date === date : true) && (masterId ? b.masterId === masterId : true)
    );
  }

  function getFreeSlots(masterId, dateStr, serviceDurationMin, stepMin = 15) {
    const master = findMaster(masterId);
    const windowStart = toMinutes(master.workWindow.start);
    const windowEnd = toMinutes(master.workWindow.end);
    const existing = listBookings({ date: dateStr, masterId });

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

  function createBooking({ masterId, serviceId, date, startTime, clientName, clientPhone }) {
    const service = findService(serviceId);
    const endTime = minutesToTime(toMinutes(startTime) + service.durationMin);

    // Проверка занятости и запись идут синхронно в одном проходе, без await между ними -
    // иначе двойной быстрый клик в UI может проскочить мимо защиты от двойного бронирования (PM, 24.07.2026)
    const all = readBookings(backend);
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
    writeBookings(backend, [...all, booking]);
    return { ok: true, booking };
  }

  function calcPayrollEstimate({ masterId, from, to } = {}) {
    const filtered = readBookings(backend).filter((b) => {
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
