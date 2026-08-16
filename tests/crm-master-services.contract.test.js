import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SERVICE_ORDER, sortByServiceOrder } from '../storage.js';

// 16.08.2026: порядок был "стабильный, но алфавитный" (ORDER BY name / service_id) -
// в трёх разных формах выбора он получался трижды разным и ни разу не совпадал с
// тем, как барбершоп продаёт услуги. Теперь порядок задаёт services.sort_order
// (миграция 049) и он один на все формы.
test('каталог и услуги мастера сортируются серверным sort_order, не алфавитом', async () => {
  const root = new URL('../', import.meta.url);
  const source = await readFile(new URL('api/routes/services.js', root), 'utf8');
  assert.match(source, /FROM services ORDER BY sort_order, name, id/);
  assert.match(source, /ORDER BY ms\.master_id, s\.sort_order, s\.name, s\.id/);
});

test('миграция 049 задаёт порядок услуг, которым Влад продаёт', async () => {
  const root = new URL('../', import.meta.url);
  const sql = await readFile(new URL('api/migrations/049_service_sort_order.sql', root), 'utf8');
  const ordered = [...sql.matchAll(/\('([a-z-]+)', (\d+)\)/g)]
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .map((m) => m[1]);
  assert.deepEqual(ordered, [
    'strizhka',
    'boroda',
    'kompleks-strizhka-boroda',
    'britie',
    'firmennaya-okantovka',
    'tonirovka',
    'vosk',
    'spa-uhod',
  ]);
  // Один порядок в базе и в storage.js - иначе фронт и бэкенд разъедутся
  assert.deepEqual(ordered, SERVICE_ORDER);
});

test('sortByServiceOrder: любой источник приводится к одному порядку', () => {
  const fromApiAlphabet = ['boroda', 'britie', 'firmennaya-okantovka', 'strizhka'];
  assert.deepEqual(
    sortByServiceOrder(fromApiAlphabet, (id) => id),
    ['strizhka', 'boroda', 'britie', 'firmennaya-okantovka']
  );
  // Строки /master-services приезжают полем serviceId, не id
  assert.deepEqual(
    sortByServiceOrder([{ serviceId: 'vosk' }, { serviceId: 'strizhka' }], (r) => r.serviceId).map((r) => r.serviceId),
    ['strizhka', 'vosk']
  );
  // Незнакомая услуга (заведена в базе позже этого файла) уходит в хвост, а не наверх
  assert.deepEqual(
    sortByServiceOrder(['novaya-usluga', 'boroda', 'strizhka'], (id) => id),
    ['strizhka', 'boroda', 'novaya-usluga']
  );
  // Исходный массив не мутируется - вызывающий код держит своё состояние сам
  const source = ['vosk', 'strizhka'];
  sortByServiceOrder(source, (id) => id);
  assert.deepEqual(source, ['vosk', 'strizhka']);
});
