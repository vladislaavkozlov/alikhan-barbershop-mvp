import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, getMasters, getServices, intervalsOverlap, mergeServiceCombos, isServiceBlockedByCombo } from '../storage.js';

function createMemoryBackend() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const [masterA, masterB] = getMasters();
const services = getServices();
const serviceById = (id) => services.find((s) => s.id === id);

test('intervalsOverlap: overlapping intervals detected (string HH:MM input)', () => {
  assert.equal(intervalsOverlap('11:00', '12:00', '11:30', '12:30'), true);
  assert.equal(intervalsOverlap('11:00', '11:30', '11:30', '12:00'), false);
});

test('getFreeSlots: пустой день возвращает слоты от 10:00 до последнего, вмещающего услугу до 20:00', async () => {
  const store = createStore(createMemoryBackend());
  const duration = 30;
  const slots = await store.getFreeSlots(masterA.id, '2026-08-01', duration);

  assert.equal(slots[0], '10:00');
  assert.equal(slots[slots.length - 1], '19:30');
  for (const slot of slots) {
    const [h, m] = slot.split(':').map(Number);
    const startMin = h * 60 + m;
    assert.ok(startMin + duration <= 20 * 60, `слот ${slot} выходит за пределы рабочего окна`);
  }
});

test('createBooking: exact match (та же длительность, то же время) → вторая запись отклонена', async () => {
  const store = createStore(createMemoryBackend());
  const boroda = serviceById('boroda');

  const first = await store.createBooking({
    masterId: masterA.id,
    serviceId: boroda.id,
    date: '2026-08-01',
    startTime: '11:00',
    clientName: 'Клиент 1',
    clientPhone: '+79990000001',
  });
  const second = await store.createBooking({
    masterId: masterA.id,
    serviceId: boroda.id,
    date: '2026-08-01',
    startTime: '11:00',
    clientName: 'Клиент 2',
    clientPhone: '+79990000002',
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'overlap');
});

test('createBooking: partial overlap (услуга 60 мин с 11:00, попытка с 11:30) → отклонена', async () => {
  const store = createStore(createMemoryBackend());
  const kompleks = serviceById('kompleks-strizhka-boroda');
  const vosk = serviceById('vosk');

  const first = await store.createBooking({
    masterId: masterA.id,
    serviceId: kompleks.id,
    date: '2026-08-01',
    startTime: '11:00',
    clientName: 'Клиент 1',
    clientPhone: '+79990000001',
  });
  const second = await store.createBooking({
    masterId: masterA.id,
    serviceId: vosk.id,
    date: '2026-08-01',
    startTime: '11:30',
    clientName: 'Клиент 2',
    clientPhone: '+79990000002',
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'overlap');
});

test('createBooking: непересекающиеся записи встык (11:00-11:30 и 11:30-12:00) → обе успешны', async () => {
  const store = createStore(createMemoryBackend());
  const boroda = serviceById('boroda');
  const okantovka = serviceById('firmennaya-okantovka');

  const first = await store.createBooking({
    masterId: masterA.id,
    serviceId: boroda.id,
    date: '2026-08-01',
    startTime: '11:00',
    clientName: 'Клиент 1',
    clientPhone: '+79990000001',
  });
  const second = await store.createBooking({
    masterId: masterA.id,
    serviceId: okantovka.id,
    date: '2026-08-01',
    startTime: '11:30',
    clientName: 'Клиент 2',
    clientPhone: '+79990000002',
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

test('createBooking: то же время, разные мастера → обе успешны', async () => {
  const store = createStore(createMemoryBackend());
  const boroda = serviceById('boroda');

  const first = await store.createBooking({
    masterId: masterA.id,
    serviceId: boroda.id,
    date: '2026-08-01',
    startTime: '11:00',
    clientName: 'Клиент 1',
    clientPhone: '+79990000001',
  });
  const second = await store.createBooking({
    masterId: masterB.id,
    serviceId: boroda.id,
    date: '2026-08-01',
    startTime: '11:00',
    clientName: 'Клиент 2',
    clientPhone: '+79990000002',
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

test('getFreeSlots: после записи 60 мин с 11:00 не содержит слоты, пересекающие [11:00,12:00)', async () => {
  const store = createStore(createMemoryBackend());
  const kompleks = serviceById('kompleks-strizhka-boroda');

  await store.createBooking({
    masterId: masterA.id,
    serviceId: kompleks.id,
    date: '2026-08-01',
    startTime: '11:00',
    clientName: 'Клиент 1',
    clientPhone: '+79990000001',
  });

  const duration = 30;
  const slots = await store.getFreeSlots(masterA.id, '2026-08-01', duration);
  const busyStart = 11 * 60;
  const busyEnd = 12 * 60;

  for (const slot of slots) {
    const [h, m] = slot.split(':').map(Number);
    const start = h * 60 + m;
    const end = start + duration;
    const overlapsBusy = start < busyEnd && busyStart < end;
    assert.equal(overlapsBusy, false, `слот ${slot} пересекается с занятым [11:00,12:00)`);
  }
});

test('createBooking: двойная попытка забронировать один слот параллельно (Promise.all) - вторая запись строго отклонена', async () => {
  const store = createStore(createMemoryBackend());
  const strizhka = serviceById('strizhka');

  const results = await Promise.all([
    store.createBooking({
      masterId: masterA.id,
      serviceId: strizhka.id,
      date: '2026-08-02',
      startTime: '12:00',
      clientName: 'Клиент 1',
      clientPhone: '+79990000001',
    }),
    store.createBooking({
      masterId: masterA.id,
      serviceId: strizhka.id,
      date: '2026-08-02',
      startTime: '12:00',
      clientName: 'Клиент 2',
      clientPhone: '+79990000002',
    }),
  ]);

  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 1);
  assert.equal((await store.listBookings({ date: '2026-08-02', masterId: masterA.id })).length, 1);
});

test('calcPayrollEstimate: сумма/диапазон по фикстурным записям считается арифметически верно', async () => {
  const store = createStore(createMemoryBackend());
  const strizhka = serviceById('strizhka'); // 2000
  const boroda = serviceById('boroda'); // 1600
  const vosk = serviceById('vosk'); // 500

  await store.createBooking({
    masterId: masterA.id,
    serviceId: strizhka.id,
    date: '2026-08-01',
    startTime: '10:00',
    clientName: 'Клиент 1',
    clientPhone: '+79990000001',
  });
  await store.createBooking({
    masterId: masterA.id,
    serviceId: boroda.id,
    date: '2026-08-01',
    startTime: '11:00',
    clientName: 'Клиент 2',
    clientPhone: '+79990000002',
  });
  await store.createBooking({
    masterId: masterA.id,
    serviceId: vosk.id,
    date: '2026-08-01',
    startTime: '12:00',
    clientName: 'Клиент 3',
    clientPhone: '+79990000003',
  });
  // Другой мастер — не должен попасть в расчёт masterA
  await store.createBooking({
    masterId: masterB.id,
    serviceId: strizhka.id,
    date: '2026-08-01',
    startTime: '10:00',
    clientName: 'Клиент 4',
    clientPhone: '+79990000004',
  });

  const result = await store.calcPayrollEstimate({ masterId: masterA.id });
  const expectedTotal = strizhka.price + boroda.price + vosk.price;

  assert.equal(result.total, expectedTotal);
  assert.equal(result.low, expectedTotal * 0.45);
  assert.equal(result.high, expectedTotal * 0.5);
});

test('getMasters/getServices: каталог соответствует брифу (3 мастера-плейсхолдера, 8 услуг)', () => {
  const masters = getMasters();
  const allServices = getServices();

  assert.equal(masters.length, 3);
  for (const m of masters) {
    assert.equal(m.isPlaceholder, true);
  }
  assert.equal(allServices.length, 8);
});

// Окно 11 (найдено Владом 30.07.2026): клиент должен иметь возможность выбрать
// несколько услуг за одну запись, не одну - длительность слота считается суммой.
test('createBooking: несколько serviceIds - endTime считается от суммы длительностей', async () => {
  const store = createStore(createMemoryBackend());
  const strizhka = serviceById('strizhka'); // 1 час (правка Влада 03.08.2026, было 40 мин)
  const boroda = serviceById('boroda'); // 30 мин

  const result = await store.createBooking({
    masterId: masterA.id,
    serviceIds: [strizhka.id, boroda.id],
    date: '2026-08-01',
    startTime: '10:00',
    clientName: 'Клиент',
    clientPhone: '+70000000000',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.booking.serviceIds, [strizhka.id, boroda.id]);
  assert.equal(result.booking.endTime, '11:30'); // 10:00 + 60 + 30 мин
});

test('calcPayrollEstimate: сумма по serviceIds считает ВСЕ услуги брони, не первую', async () => {
  const store = createStore(createMemoryBackend());
  const strizhka = serviceById('strizhka');
  const boroda = serviceById('boroda');

  await store.createBooking({
    masterId: masterA.id,
    serviceIds: [strizhka.id, boroda.id],
    date: '2026-08-01',
    startTime: '10:00',
    clientName: 'Клиент',
    clientPhone: '+70000000000',
  });

  const result = await store.calcPayrollEstimate({ masterId: masterA.id });
  assert.equal(result.total, strizhka.price + boroda.price);
});

// Правки Влада 03.08.2026 (п.3/4): "стрижка"+"борода" отдельно нельзя выбрать
// одновременно с "Комплекс стрижка+борода" (уже включают друг друга), а отдельный
// выбор обоих компонентов сам должен схлопнуться в комплекс.
test('mergeServiceCombos: отдельные "стрижка"+"борода" сворачиваются в комплекс', () => {
  const merged = mergeServiceCombos(new Set(['strizhka', 'boroda']));
  assert.deepEqual([...merged].sort(), ['kompleks-strizhka-boroda']);
});

test('mergeServiceCombos: если выбрана только одна из двух услуг - слияния не происходит', () => {
  const merged = mergeServiceCombos(new Set(['strizhka', 'vosk']));
  assert.deepEqual([...merged].sort(), ['strizhka', 'vosk']);
});

test('mergeServiceCombos: слияние учитывает и другие уже выбранные услуги, не только пару', () => {
  const merged = mergeServiceCombos(new Set(['strizhka', 'boroda', 'vosk']));
  assert.deepEqual([...merged].sort(), ['kompleks-strizhka-boroda', 'vosk']);
});

test('isServiceBlockedByCombo: комплекс блокирует стрижку/бороду/бритьё/окантовку', () => {
  const selected = new Set(['kompleks-strizhka-boroda']);
  for (const id of ['strizhka', 'boroda', 'britie', 'firmennaya-okantovka']) {
    assert.equal(isServiceBlockedByCombo(id, selected), true, `${id} должен быть заблокирован`);
  }
  assert.equal(isServiceBlockedByCombo('vosk', selected), false);
});

test('isServiceBlockedByCombo: без выбранного комплекса ничего не блокируется', () => {
  const selected = new Set(['strizhka']);
  assert.equal(isServiceBlockedByCombo('boroda', selected), false);
  assert.equal(isServiceBlockedByCombo('britie', selected), false);
});
