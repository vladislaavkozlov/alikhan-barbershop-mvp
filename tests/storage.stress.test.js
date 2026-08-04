import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, getMasters, getServices, intervalsOverlap } from '../storage.js';

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

// mulberry32 — детерминированный seeded PRNG, чтобы прогон был воспроизводим.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 1337;
const N = 150;
const WINDOW_START = 10 * 60; // 10:00
const WINDOW_END = 20 * 60; // 20:00

const masters = getMasters();
const services = getServices();

const DATES = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09'];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function toMinutes(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function genBookingAttempts(seed, n) {
  const rng = mulberry32(seed);
  const attempts = [];
  for (let i = 0; i < n; i++) {
    const master = pick(rng, masters);
    const service = pick(rng, services);
    const date = pick(rng, DATES);
    // случайный старт в пределах рабочего окна, шаг 5 минут для разнообразия
    const startMin = WINDOW_START + Math.floor(rng() * ((WINDOW_END - WINDOW_START) / 5)) * 5;
    attempts.push({
      masterId: master.id,
      serviceId: service.id,
      date,
      startTime: minutesToTime(startMin),
      clientName: `Клиент ${i}`,
      clientPhone: `+7999${String(i).padStart(7, '0')}`,
    });
  }
  return attempts;
}

async function runStressPass(seed, n) {
  const store = createStore(createMemoryBackend());
  const results = await attemptAndCollect(store, genBookingAttempts(seed, n));
  return { store, ...results };
}

async function attemptAndCollect(store, attempts) {
  const accepted = [];
  for (const attempt of attempts) {
    const res = await store.createBooking(attempt);
    if (res.ok) {
      accepted.push(res.booking);

      // Инвариант 1: ни у одного мастера нет двух пересекающихся принятых записей
      const sameMasterSameDay = accepted.filter(
        (b) => b.masterId === res.booking.masterId && b.date === res.booking.date && b.id !== res.booking.id
      );
      for (const other of sameMasterSameDay) {
        const overlap = intervalsOverlap(res.booking.startTime, res.booking.endTime, other.startTime, other.endTime);
        assert.equal(
          overlap,
          false,
          `Инвариант 1 нарушен: ${res.booking.masterId} ${res.booking.date} новая [${res.booking.startTime},${res.booking.endTime}) пересекается с существующей [${other.startTime},${other.endTime})`
        );
      }
    }
  }
  return { accepted };
}

test('stress: 150 случайных попыток бронирования — ни одного пересечения у принятых записей одного мастера', async () => {
  const { accepted } = await runStressPass(SEED, N);
  assert.ok(accepted.length > 0, 'ожидался хотя бы один успешный booking для содержательного теста');

  // Полная перепроверка инварианта 1 по итоговому множеству (не только инкрементально)
  for (const master of masters) {
    for (const date of DATES) {
      const bookings = accepted.filter((b) => b.masterId === master.id && b.date === date);
      for (let i = 0; i < bookings.length; i++) {
        for (let j = i + 1; j < bookings.length; j++) {
          const overlap = intervalsOverlap(
            bookings[i].startTime,
            bookings[i].endTime,
            bookings[j].startTime,
            bookings[j].endTime
          );
          assert.equal(
            overlap,
            false,
            `Пересечение у мастера ${master.id} на ${date}: [${bookings[i].startTime},${bookings[i].endTime}) и [${bookings[j].startTime},${bookings[j].endTime})`
          );
        }
      }
    }
  }
});

test('stress: getFreeSlots никогда не предлагает слот, пересекающий уже принятую запись того же мастера', async () => {
  const { store, accepted } = await runStressPass(SEED, N);

  for (const master of masters) {
    for (const date of DATES) {
      for (const service of services) {
        const slots = await store.getFreeSlots(master.id, date, service.durationMin);
        const busy = accepted.filter((b) => b.masterId === master.id && b.date === date);

        for (const slot of slots) {
          const slotStart = toMinutes(slot);
          const slotEnd = slotStart + service.durationMin;
          for (const b of busy) {
            const overlap = intervalsOverlap(slotStart, slotEnd, b.startTime, b.endTime);
            assert.equal(
              overlap,
              false,
              `getFreeSlots предложил слот ${slot} (${service.id}, ${service.durationMin}мин) для ${master.id} ${date}, пересекающий принятую запись [${b.startTime},${b.endTime})`
            );
          }
        }
      }
    }
  }
});

test('stress: calcPayrollEstimate для каждого мастера равен сумме цен его принятых записей', async () => {
  const { store, accepted } = await runStressPass(SEED, N);
  const serviceById = (id) => services.find((s) => s.id === id);

  for (const master of masters) {
    const expectedTotal = accepted
      .filter((b) => b.masterId === master.id)
      .reduce((sum, b) => sum + serviceById(b.serviceId).price, 0);

    const result = await store.calcPayrollEstimate({ masterId: master.id });

    assert.equal(result.total, expectedTotal, `calcPayrollEstimate.total разошёлся с суммой цен для ${master.id}`);
    assert.equal(result.low, expectedTotal * 0.45, `low разошёлся для ${master.id}`);
    assert.equal(result.high, expectedTotal * 0.5, `high разошёлся для ${master.id}`);
  }

  // И общий расчёт (без фильтра по мастеру) должен совпасть с суммой по всем
  const grandExpected = accepted.reduce((sum, b) => sum + serviceById(b.serviceId).price, 0);
  const grandResult = await store.calcPayrollEstimate({});
  assert.equal(grandResult.total, grandExpected, 'calcPayrollEstimate без фильтра разошёлся с суммой всех принятых записей');
});

test('stress: детерминированность — тот же seed даёт тот же результат при повторном прогоне', async () => {
  const runA = await runStressPass(SEED, N);
  const runB = await runStressPass(SEED, N);

  assert.equal(runA.accepted.length, runB.accepted.length, 'разное число принятых записей между прогонами с одним seed');

  const normalize = (list) =>
    list
      .map((b) => `${b.masterId}|${b.serviceId}|${b.date}|${b.startTime}|${b.endTime}`)
      .sort();

  assert.deepEqual(
    normalize(runA.accepted),
    normalize(runB.accepted),
    'состав принятых записей отличается между прогонами с одним seed — недетерминированность'
  );
});
