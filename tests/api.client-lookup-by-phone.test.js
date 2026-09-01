// Окно 54 (10.08.2026, Задача A) - поиск клиента по телефону, GET /clients?phone=.
// Контракт под Окно 55 (слияние двух форм записи): администратор вводит телефон и
// сразу видит, есть такой клиент в базе или это новый - до этого окна такого
// эндпоинта не было вообще (GET /clients без ?risk=true отвечал 400).
//
// Тот же паттерн in-memory fake client, что уже применён в
// tests/api.clients-risk.test.js - здесь проверяется форма данных и решения
// резолверов; реальные HTTP-коды/роли/SQL против настоящего Postgres проверяет
// живой прогон tools/verify-2026-08-10-okno54.mjs (DoD этого окна).
//
// ЧЕСТНАЯ ПОПРАВКА К ТЗ (правило 3 из CLAUDE.md). Промпт говорил "нормализовать
// телефон тем же способом, что использует INSERT ... ON CONFLICT (phone)". По коду
// (api/routes/bookings.js:113-119) никакой нормализации там НЕТ - телефон пишется
// ровно той строкой, что прислал клиент, а unique-индекс clients_phone_key
// (миграция 002) построен на сыром значении. Форматы при этом реально разные:
// публичный виджет форматирует "+7 999 123 45 67" через formatPhone (app.js:382),
// а CRM-форма walk-in шлёт `clientPhoneEl.value.trim()` как есть (crm-walkin.js:273).
// Поэтому "тот же способ" - невозможен, а точное сравнение строк провалило бы
// сценарий 3. Нормализация сделана НА СТОРОНЕ ПОИСКА и симметрично для обеих
// сторон сравнения (последние 10 цифр), путь записи в этом окне не тронут -
// менять его = трогать POST /bookings и мигрировать уже накопленные строки, это
// отдельное решение Влада, не побочный эффект контракта на чтение.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneKey, findClientByPhone, resolveClientsQueryMode, shapeClientCardForViewer } from '../api/server.mjs';

function makeFakeClient({ lookupRows = [], clientRows = [], visitRows = [], serviceLinkRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      // Запрос поиска по телефону отличается от остальных наличием regexp_replace -
      // проверяем его ПЕРВЫМ, до общего 'FROM clients' (тот же приём упорядоченного
      // диспатча, что в tests/api.clients-risk.test.js).
      if (sql.includes('regexp_replace')) return { rows: lookupRows };
      // Состояние бота у клиента (Волна 1, 01.09.2026): карточка спрашивает его
      // всегда, а этим тестам оно неинтересно - отвечаем «бота нет»
      if (sql.includes('FROM client_channels')) return { rows: [] };
      if (sql.includes('FROM booking_services')) return { rows: serviceLinkRows };
      if (sql.includes('FROM bookings')) return { rows: visitRows };
      if (sql.includes('FROM clients')) return { rows: clientRows };
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

// ── normalizePhoneKey - ключ сравнения ───────────────────────────────────────

test('Сценарий 3 (единица): +7 / 8 / пробелы / скобки / дефисы одного номера дают ОДИН ключ', () => {
  const variants = [
    '+79991234567',
    '+7 999 123 45 67',
    '8 999 123-45-67',
    '89991234567',
    '8(999)1234567',
    '9991234567',
    ' +7  999  123  45  67 ',
  ];
  const keys = new Set(variants.map(normalizePhoneKey));
  assert.equal(keys.size, 1, `разные ключи: ${JSON.stringify([...keys])}`);
  assert.equal([...keys][0], '9991234567');
});

test('normalizePhoneKey: разные номера НЕ схлопываются в один ключ', () => {
  assert.notEqual(normalizePhoneKey('+79991234567'), normalizePhoneKey('+79991234568'));
});

test('normalizePhoneKey: пустая строка/null/только мусор - null (не ключ, поиска не будет)', () => {
  assert.equal(normalizePhoneKey(''), null);
  assert.equal(normalizePhoneKey(null), null);
  assert.equal(normalizePhoneKey(undefined), null);
  assert.equal(normalizePhoneKey('   '), null);
  assert.equal(normalizePhoneKey('+()- '), null);
});

test('normalizePhoneKey: короткий номер (меньше 10 цифр) сравнивается целиком, не обрезается', () => {
  // Иначе клиент, записанный администратором с укороченным номером, стал бы
  // ненаходимым вовсе - лучше точное сравнение по тем цифрам, что есть.
  assert.equal(normalizePhoneKey('12345'), '12345');
});

// ── resolveClientsQueryMode - какая ветка GET /clients ───────────────────────

test('Сценарий 5: ни phone, ни risk=true - режим invalid (роут отвечает 400 missing_fields, старое поведение не сломано)', () => {
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('')), { mode: 'invalid' });
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('risk=false')), { mode: 'invalid' });
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('foo=bar')), { mode: 'invalid' });
});

test('resolveClientsQueryMode: risk=true - прежняя ветка списка риска, не тронута', () => {
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('risk=true')), { mode: 'risk' });
});

test('resolveClientsQueryMode: phone=... - новая ветка поиска, телефон отдан как есть (нормализует резолвер)', () => {
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('phone=%2B79991234567')), {
    mode: 'phone',
    phone: '+79991234567',
  });
});

test('resolveClientsQueryMode: phone= пустой - это НЕ поиск, а отсутствие фильтра (400 missing_fields)', () => {
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('phone=')), { mode: 'invalid' });
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('phone=%20%20')), { mode: 'invalid' });
});

test('resolveClientsQueryMode: phone важнее risk, если пришли оба (явный поиск конкретнее общего списка)', () => {
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('risk=true&phone=%2B79991234567')), {
    mode: 'phone',
    phone: '+79991234567',
  });
});

// ── findClientByPhone ────────────────────────────────────────────────────────

test('Сценарий 1: существующий телефон - полная карточка той же формы, что GET /clients/:id, с lastVisit', async () => {
  const client = makeFakeClient({
    lookupRows: [{ id: 'c1' }],
    clientRows: [{ id: 'c1', name: 'Иван', phone: '+7 999 123 45 67', birthday: null, no_show_streak: 0 }],
    visitRows: [
      { id: 'b2', date: '2026-08-05', start_time: '11:00', end_time: '11:40', status: 'done', master_id: 'master-1', location_id: 1, master_name: 'Алиовсад' },
      { id: 'b1', date: '2026-07-20', start_time: '10:00', end_time: '10:30', status: 'done', master_id: 'master-1', location_id: 1, master_name: 'Алиовсад' },
    ],
    serviceLinkRows: [{ booking_id: 'b2', service_id: 'strizhka', service_name: 'Стрижка' }],
  });
  const card = await findClientByPhone(client, '8 999 123 45 67');
  assert.equal(card.id, 'c1');
  assert.equal(card.name, 'Иван');
  assert.equal(card.phone, '+7 999 123 45 67');
  assert.equal(card.noShowStreak, 0);
  assert.deepEqual(card.risk, { level: 'none', label: null });
  assert.equal(card.lastVisit.masterId, 'master-1');
  assert.deepEqual(card.lastVisit.services, [{ id: 'strizhka', name: 'Стрижка' }]);
});

test('Сценарий 2: телефона нет в базе - null (роут превращает это в 404 client_not_found)', async () => {
  const client = makeFakeClient({ lookupRows: [] });
  assert.equal(await findClientByPhone(client, '+79990000000'), null);
});

test('findClientByPhone: пустой телефон - null без единого запроса к базе', async () => {
  const client = makeFakeClient({ lookupRows: [{ id: 'c1' }] });
  assert.equal(await findClientByPhone(client, '   '), null);
  assert.equal(client.calls.length, 0);
});

test('Сценарий 3 (в резолвере): любой формат ввода уходит в SQL одним и тем же ключом, сравнение симметрично нормализует и колонку', async () => {
  const keys = [];
  for (const raw of ['+79991234567', '8 999 123-45-67', '9991234567']) {
    const client = makeFakeClient({ lookupRows: [] });
    await findClientByPhone(client, raw);
    keys.push(client.calls[0].params[0]);
    // Колонка phone в WHERE нормализуется тем же правилом - иначе сырое
    // "+7 999 123 45 67" из публичного виджета не совпало бы с ключом цифр.
    assert.match(client.calls[0].sql, /regexp_replace\(phone/);
    assert.match(client.calls[0].sql, /right\(regexp_replace\(phone[^)]*\)[^,]*, 10\)/);
  }
  assert.equal(new Set(keys).size, 1, `в SQL ушли разные ключи: ${JSON.stringify(keys)}`);
});

test('findClientByPhone: при дублях в разных форматах точное совпадение строки выигрывает (детерминированный выбор, не случайная строка)', async () => {
  const client = makeFakeClient({ lookupRows: [{ id: 'c1' }], clientRows: [{ id: 'c1', name: 'И', phone: '+79991234567', birthday: null, no_show_streak: 0 }] });
  await findClientByPhone(client, '+79991234567');
  assert.match(client.calls[0].sql, /ORDER BY \(phone = \$2\) DESC/);
  assert.equal(client.calls[0].params[1], '+79991234567');
  assert.match(client.calls[0].sql, /LIMIT 1/);
});

// ── shapeClientCardForViewer - видимость по роли ─────────────────────────────

const FULL_CARD = {
  id: 'c1',
  name: 'Иван',
  phone: '+79991234567',
  birthday: null,
  noShowStreak: 1,
  risk: { level: 'watch', label: 'Пропустил последнюю запись - стоит позвонить' },
  visits: [
    { id: 'b3', date: '2026-08-05', startTime: '11:00', endTime: '11:40', status: 'done', masterId: 'master-2', masterName: 'Мастер 2', locationId: 2, services: [{ id: 'boroda', name: 'Борода' }] },
    { id: 'b2', date: '2026-08-01', startTime: '10:00', endTime: '10:30', status: 'done', masterId: 'master-1', masterName: 'Алиовсад', locationId: 1, services: [{ id: 'strizhka', name: 'Стрижка' }] },
  ],
  lastVisit: { masterId: 'master-2', masterName: 'Мастер 2', services: [{ id: 'boroda', name: 'Борода' }] },
};

test('Сценарий 4: мастер не видит телефон клиента (тот же уровень, что уже принят в GET /clients/:id)', () => {
  const shaped = shapeClientCardForViewer(FULL_CARD, { role: 'master', id: 'master-1', locationId: 1 });
  assert.equal('phone' in shaped, false);
  assert.equal(shaped.id, 'c1');
  assert.equal(shaped.name, 'Иван');
});

test('shapeClientCardForViewer: мастер видит в истории только СВОИ визиты, lastVisit пересчитан по ним', () => {
  const shaped = shapeClientCardForViewer(FULL_CARD, { role: 'master', id: 'master-1', locationId: 1 });
  assert.equal(shaped.visits.length, 1);
  assert.equal(shaped.visits[0].masterId, 'master-1');
  assert.equal(shaped.lastVisit.masterId, 'master-1');
});

test('shapeClientCardForViewer: администратор видит телефон, но историю только своей точки', () => {
  const shaped = shapeClientCardForViewer(FULL_CARD, { role: 'admin', id: 'admin-1', locationId: 1 });
  assert.equal(shaped.phone, '+79991234567');
  assert.equal(shaped.visits.length, 1);
  assert.equal(shaped.visits[0].locationId, 1);
  assert.equal(shaped.lastVisit.masterId, 'master-1');
});

test('shapeClientCardForViewer: владелец видит карточку целиком, ничего не срезано', () => {
  const shaped = shapeClientCardForViewer(FULL_CARD, { role: 'owner', id: 'owner-1', locationId: null });
  // 21.08.2026 (раздел «Клиенты») карточка обзавелась итогами totals - их считает
  // shapeClientCardForViewer из ТОЙ ЖЕ истории, что уедет на фронт, поэтому у
  // владельца они появляются даже если в исходной фикстуре их не было. Всё
  // остальное по-прежнему обязано совпадать один в один - это и проверяем.
  const { totals, ...rest } = shaped;
  assert.deepEqual(rest, FULL_CARD);
  assert.equal(typeof totals.revenue, 'number');
});

test('shapeClientCardForViewer: клиент есть, но ни одного видимого этой роли визита - карточка отдаётся (клиент опознан), история пустая, lastVisit null', () => {
  // Ключевое product-решение окна: НЕ 403 и НЕ 404. Иначе Окно 55 приняло бы
  // существующего клиента другой точки за нового и завело бы дубль - при том что
  // сам бэкенд при сохранении брони всё равно свяжет его с тем же clients-рядом
  // через ON CONFLICT (phone). Приватность соблюдена срезкой истории, а не
  // отрицанием существования клиента.
  const shaped = shapeClientCardForViewer(FULL_CARD, { role: 'master', id: 'master-99', locationId: 1 });
  assert.equal(shaped.id, 'c1');
  assert.deepEqual(shaped.visits, []);
  assert.equal(shaped.lastVisit, null);
});
