// 17.08.2026 - «время записи к сотрудникам должно работать по времени записи и в CRM,
// и на сайте» (Влад). Публичный виджет строит слоты через store.getFreeSlots, а тот
// брал рабочее окно у getEffectiveWindowFor. Найдено при живом прогоне круглосуточного
// графика: getEffectiveWindowFor начинался с findMaster(masterId), а findMaster знает
// ТОЛЬКО жёстко прописанных в storage.js master-1/2/3 и на любом другом id бросает
// «Неизвестный masterId» - то есть у мастера, созданного через интерфейс CRM
// (staff-<hex>), сайт вообще не показывал свободное время, а писал клиенту «Не удалось
// загрузить свободное время - проверьте подключение» (catch в app.js refreshSlots).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../storage.js';

// Бэкенд-заглушка уровня «rich» (как apiBackend): свои брони + свой график
function createBackend(shift) {
  return {
    async listBookings() { return []; },
    async createBooking() { return { ok: true }; },
    async getSchedule({ date }) { return shift ? [{ date, ...shift }] : []; },
  };
}

const UNKNOWN_MASTER = 'staff-3f9ab21c'; // такой id выдаёт CRM при создании сотрудника

test('мастер, созданный через CRM, получает слоты по своему графику, а не исключение', async () => {
  const store = createStore(createBackend({ startTime: '00:00', endTime: '23:59', breaks: [] }));
  const slots = await store.getFreeSlots(UNKNOWN_MASTER, '2030-01-05', 60);
  assert.equal(slots[0], '00:00');
  assert.ok(slots.includes('02:00'), 'ночной слот обязан предлагаться при графике 00:00-23:59');
  assert.equal(slots.at(-1), '22:45'); // 23:00 + 60 мин уже за 23:59
});

test('круглосуточный график сужается перерывом мастера', async () => {
  const store = createStore(createBackend({
    startTime: '00:00', endTime: '23:59', breaks: [{ startTime: '02:00', endTime: '05:00' }],
  }));
  const slots = await store.getFreeSlots(UNKNOWN_MASTER, '2030-01-05', 60);
  assert.ok(!slots.includes('02:00'));
  assert.ok(!slots.includes('04:00'));
  assert.ok(slots.includes('05:00'));
});

test('без графика от сервера остаётся глобальный дефолт салона 10:00-20:00', async () => {
  const store = createStore(createBackend(null));
  const slots = await store.getFreeSlots(UNKNOWN_MASTER, '2030-01-05', 60);
  assert.equal(slots[0], '10:00');
  assert.equal(slots.at(-1), '19:00');
});

test('известный мастер из справочника продолжает работать как раньше', async () => {
  const store = createStore(createBackend({ startTime: '12:00', endTime: '18:00', breaks: [] }));
  const slots = await store.getFreeSlots('master-1', '2030-01-05', 60);
  assert.equal(slots[0], '12:00');
  assert.equal(slots.at(-1), '17:00');
});
