// Раздел «Аналитика» владельца (22.08.2026): возвращаемость по салону и по каждому
// сотруднику + распределение записей по каналам привлечения.
//
// Тот же приём in-memory fake client, что в tests/api.revenue-today.test.js: реальная
// фильтрация по датам живёт в SQL и проверяется живым прогоном, здесь - арифметика,
// граница «не из чего считать» (null, а не 0%) и то, что список мастеров собирается
// из сотрудников, а не только из тех, у кого были визиты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRetention,
  computeClientSources,
  computeLapsedClients,
  computeUnlinkedVisits,
  percentOf,
  shapeSourceRows,
  parseMonths,
  RETENTION_MONTHS,
  SOURCE_MONTHS,
} from '../api/routes/analytics.js';

const KEYS = ['yandex_maps', '2gis', 'instagram', 'telegram', 'vk', 'referral', 'walkin', 'other'];

function fakeDb({ salon = [{ clients: 0, returned: 0, visits: 0, waiting: 0 }], masters = [], unlinked = [{ n: 0 }], staff = [], sources = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('GROUP BY b.master_id, b.client_id')) return { rows: masters };
      if (sql.includes('FROM mature')) return { rows: salon };
      if (sql.includes('GROUP BY b.client_id')) return { rows: salon };
      if (sql.includes('client_id IS NULL')) return { rows: unlinked };
      if (sql.includes('FROM staff')) return { rows: staff };
      if (sql.includes('GROUP BY b.client_source')) return { rows: sources };
      throw new Error(`unexpected SQL in fake db: ${sql}`);
    },
  };
}

test('percentOf: без базы возвращает null, а не ноль', () => {
  assert.equal(percentOf(0, 0), null);
  assert.equal(percentOf(3, 10), 30);
  assert.equal(percentOf(1, 3), 33);
});

test('parseMonths: принимает только периоды, которые есть в интерфейсе', () => {
  assert.equal(parseMonths('6', RETENTION_MONTHS), 6);
  assert.equal(parseMonths('999', RETENTION_MONTHS), null);
  assert.equal(parseMonths('1', RETENTION_MONTHS), null); // месяц есть только у каналов
  assert.equal(parseMonths('1', SOURCE_MONTHS), 1);
  assert.equal(parseMonths('abc', SOURCE_MONTHS), null);
  assert.equal(parseMonths(null, SOURCE_MONTHS), null);
});

test('возвращаемость: салон и мастера считаются от своей базы', async () => {
  const db = fakeDb({
    salon: [{ clients: 10, returned: 6, visits: 22, waiting: 2 }],
    masters: [
      { master_id: 'm1', clients: 8, returned: 4, visits: 14 },
      { master_id: 'm2', clients: 4, returned: 1, visits: 5 },
    ],
    unlinked: [{ n: 3 }],
    staff: [
      { id: 'm1', name: 'Алиовсад', employed: true, provides_services: true },
      { id: 'm2', name: 'Мамедхан', employed: true, provides_services: true },
      { id: 'm3', name: 'Елизавета', employed: true, provides_services: true },
      { id: 'adm', name: 'Администратор', employed: true, provides_services: false },
    ],
  });
  const result = await computeRetention(db, 6);
  assert.equal(result.months, 6);
  assert.equal(result.salon.pct, 60);
  assert.equal(result.salon.waiting, 2, 'недавние клиенты вынесены отдельно, а не влиты в процент');
  assert.equal(result.graceMonths, 1);
  assert.equal(result.unlinkedVisits, 3);
  // Администратор услуг не оказывает - в списке его нет; мастер без визитов есть
  assert.deepEqual(result.masters.map((m) => m.masterId), ['m1', 'm2', 'm3']);
  assert.equal(result.masters[0].pct, 50);
  assert.equal(result.masters[1].pct, 25);
  // Нет клиентов за период - прочерк, а не 0%: это разные сообщения владельцу
  assert.equal(result.masters[2].pct, null);
  assert.equal(result.masters[2].clients, 0);
});

test('возвращаемость: уволенный мастер не исчезает из истории периода', async () => {
  const db = fakeDb({
    salon: [{ clients: 2, returned: 1, visits: 3 }],
    masters: [{ master_id: 'gone', clients: 2, returned: 1, visits: 3 }],
    staff: [
      { id: 'gone', name: 'Бывший мастер', employed: false, provides_services: true },
      { id: 'm1', name: 'Алиовсад', employed: true, provides_services: true },
    ],
  });
  const result = await computeRetention(db, 12);
  const gone = result.masters.find((m) => m.masterId === 'gone');
  assert.ok(gone, 'мастер с визитами в периоде должен остаться в списке');
  assert.equal(gone.employed, false);
  assert.equal(gone.pct, 50);
});

test('возвращаемость: пустой период не выдаёт нулевых процентов', async () => {
  const db = fakeDb({ staff: [{ id: 'm1', name: 'Алиовсад', employed: true, provides_services: true }] });
  const result = await computeRetention(db, 3);
  assert.equal(result.salon.clients, 0);
  assert.equal(result.salon.pct, null);
  assert.equal(result.masters[0].pct, null);
});

test('каналы: доли считаются от всех записей периода, сортировка по величине', async () => {
  const db = fakeDb({
    sources: [
      { key: 'yandex_maps', n: 5 },
      { key: '2gis', n: 3 },
      { key: 'instagram', n: 2 },
    ],
  });
  const result = await computeClientSources(db, 3, KEYS);
  assert.equal(result.total, 10);
  assert.deepEqual(
    result.rows.slice(0, 3).map((r) => [r.key, r.count, r.pct]),
    [['yandex_maps', 5, 50], ['2gis', 3, 30], ['instagram', 2, 20]]
  );
  // Каналы без единой записи остаются в списке - владельцу важно видеть, что
  // площадка есть, а клиентов с неё нет
  assert.equal(result.rows.length, KEYS.length);
  assert.ok(result.rows.every((r) => r.key !== null));
});

test('каналы: записи без источника - отдельная последняя строка, а не выдуманный канал', async () => {
  const db = fakeDb({ sources: [{ key: 'yandex_maps', n: 3 }, { key: null, n: 1 }] });
  const result = await computeClientSources(db, 1, KEYS);
  const last = result.rows[result.rows.length - 1];
  assert.equal(last.key, null);
  assert.equal(last.count, 1);
  assert.equal(result.total, 4);
});

test('каналы: ключ не из словаря уходит в «не указан», а не показывается сырым', () => {
  const shaped = shapeSourceRows({ yandex_maps: 2, unknown: 1 }, KEYS);
  assert.equal(shaped.total, 3);
  assert.equal(shaped.rows.filter((r) => r.key === null).length, 1);
});

test('каналы: пустой период не делит на ноль', async () => {
  const result = await computeClientSources(fakeDb(), 12, KEYS);
  assert.equal(result.total, 0);
  assert.ok(result.rows.every((r) => r.pct === null));
});

// ── Кто не вернулся (22.08.2026) ────────────────────────────────────────────
function fakeLapsedDb(rows, { capture } = {}) {
  return {
    async query(sql, params) {
      if (capture) capture(sql, params);
      return { rows };
    },
  };
}

test('невернувшиеся: список сходится с процентом - только те, кто был ровно раз', async () => {
  const capture = [];
  const db = fakeLapsedDb(
    [{ id: 'c1', name: 'Иван', phone: '+79990001111', last_date: new Date('2026-06-01T00:00:00Z') }],
    { capture: (sql, params) => capture.push({ sql, params }) }
  );
  const result = await computeLapsedClients(db, 6);
  assert.equal(result.months, 6);
  assert.equal(result.masterId, null);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.clients, [{ clientId: 'c1', name: 'Иван', phone: '+79990001111', lastVisit: '2026-06-01' }]);
  // Тот же критерий, что у процента выше: один состоявшийся визит за период
  assert.match(capture[0].sql, /HAVING count\(\*\) = 1/);
  assert.match(capture[0].sql, /status = 'done'/);
  assert.deepEqual(capture[0].params, [6]);
});

test('невернувшиеся по мастеру: id уезжает параметром, а не склейкой строки', async () => {
  const capture = [];
  const db = fakeLapsedDb([], { capture: (sql, params) => capture.push({ sql, params }) });
  await computeLapsedClients(db, 3, "m1'; DROP TABLE bookings; --");
  assert.deepEqual(capture[0].params, [3, "m1'; DROP TABLE bookings; --"]);
  assert.ok(!capture[0].sql.includes('DROP TABLE'), 'id не должен попадать в текст запроса');
  assert.match(capture[0].sql, /b\.master_id = \$2/);
});

test('невернувшиеся: длинный список честно помечен обрезанным', async () => {
  const rows = Array.from({ length: 201 }, (_, i) => ({ id: `c${i}`, name: `Клиент ${i}`, phone: null, last_date: '2026-07-01' }));
  const result = await computeLapsedClients(fakeLapsedDb(rows), 12);
  assert.equal(result.clients.length, 200);
  assert.equal(result.truncated, true);
});

test('визиты без телефона считаются отдельно от базы клиентов', async () => {
  const db = {
    async query(sql) {
      assert.match(sql, /client_id IS NULL/);
      return { rows: [{ visits: 12, visits_month: 3 }] };
    },
  };
  assert.deepEqual(await computeUnlinkedVisits(db), { visits: 12, visitsMonth: 3 });
});

// ── Окно ожидания: месяц после визита (22.08.2026) ──────────────────────────
// Правка Влада: «клиентов, которые не вернулись, нужно считать с месяца после визита.
// Там Гэндальф 19.08 пишет не вернулся - он каждый день что ли стричься должен?»
test('окно ожидания применяется к ОБЕИМ цифрам - и к проценту, и к списку', async () => {
  const captured = [];
  const db = fakeDb({ salon: [{ clients: 5, returned: 3, visits: 9, waiting: 4 }] });
  const origQuery = db.query.bind(db);
  db.query = async (sql, params) => { captured.push(sql); return origQuery(sql, params); };
  const result = await computeRetention(db, 6);
  // Знаменатель процента - только «созревшие» клиенты, свежие ждут своего часа
  const salonSql = captured.find((q) => q.includes('FROM mature'));
  assert.match(salonSql, /n >= 2 OR last_date <= CURRENT_DATE - make_interval\(months => 1\)/);
  const masterSql = captured.find((q) => q.includes('GROUP BY b.master_id, b.client_id'));
  assert.match(masterSql, /n >= 2 OR last_date <= CURRENT_DATE - make_interval\(months => 1\)/);
  assert.equal(result.salon.waiting, 4);
});

test('невернувшиеся: клиент, приходивший на этой неделе, в список не попадает', async () => {
  const capture = [];
  const db = fakeLapsedDb([], { capture: (sql) => capture.push(sql) });
  await computeLapsedClients(db, 3);
  // Один визит И с него прошёл месяц - оба условия, иначе список разойдётся с процентом
  assert.match(capture[0], /HAVING count\(\*\) = 1 AND max\(b\.date\) <= CURRENT_DATE - make_interval\(months => 1\)/);
});
