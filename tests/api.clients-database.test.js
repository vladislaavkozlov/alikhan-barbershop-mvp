// Раздел «Клиенты» (21.08.2026, задача Влада: «база данных клиентов - имена, телефоны,
// комментарии, откуда и когда пришли, история записей, сколько денег принесли»).
//
// Здесь проверяется ФОРМА данных и решения чистых функций: что считается визитом,
// что считается деньгами, какая ветка GET /clients запрошена. Реальные HTTP-коды,
// роли (403 администратору на ?all=true) и настоящий SQL против Postgres - живой
// прогон tools/verify-2026-08-21-clients.mjs, тот же порядок, что и в остальных
// окнах: офлайн-тест не подменяет живую проверку и не притворяется ею.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveClientsQueryMode, summarizeClientVisits, listAllClients, BOOKING_COMMENT_MAX_LEN } from '../api/server.mjs';

// Визиты приходят из getClientCard отсортированными по дате ВНИЗ (сначала свежие) -
// фикстура повторяет этот порядок, иначе «первый визит» считался бы не с того конца.
const VISITS = [
  { id: 'b4', date: '2026-08-20', status: 'planned', price: 1500, clientSource: null },
  { id: 'b3', date: '2026-08-10', status: 'done', price: 2000, clientSource: null },
  { id: 'b2', date: '2026-07-05', status: 'no_show', price: 1500, clientSource: null },
  { id: 'b1', date: '2026-06-01', status: 'done', price: 1200, clientSource: 'yandex_maps' },
];

test('Деньги - только состоявшиеся визиты: «ожидается» и неявка в сумму не входят', () => {
  const totals = summarizeClientVisits(VISITS);
  assert.equal(totals.visitsCount, 2);
  assert.equal(totals.revenue, 3200); // 2000 + 1200, без planned(1500) и no_show(1500)
  assert.equal(totals.lastVisitDate, '2026-08-10');
});

test('«Когда и откуда пришёл» - первая НЕотменённая бронь, а не первая состоявшаяся', () => {
  const totals = summarizeClientVisits(VISITS);
  assert.equal(totals.firstVisitDate, '2026-06-01');
  assert.equal(totals.source, 'yandex_maps');
});

test('Отменённая бронь первым касанием не считается - клиент тогда не приходил', () => {
  const withCancelled = [...VISITS, { id: 'b0', date: '2026-05-01', status: 'cancelled', price: 900, clientSource: '2gis' }];
  const totals = summarizeClientVisits(withCancelled);
  assert.equal(totals.firstVisitDate, '2026-06-01');
  assert.equal(totals.source, 'yandex_maps');
  assert.equal(totals.revenue, 3200);
});

test('Клиент без единого визита: нули и null, а не пустые строки и не NaN', () => {
  assert.deepEqual(summarizeClientVisits([]), {
    visitsCount: 0,
    revenue: 0,
    firstVisitDate: null,
    lastVisitDate: null,
    source: null,
  });
});

test('Визит без цены (услуги не завели в прайс) не ломает сумму - считается как 0', () => {
  const totals = summarizeClientVisits([{ id: 'x', date: '2026-08-01', status: 'done', price: null, clientSource: null }]);
  assert.equal(totals.revenue, 0);
  assert.equal(totals.visitsCount, 1);
});

test('resolveClientsQueryMode: all=true - новая ветка всей базы', () => {
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('all=true')), { mode: 'all' });
});

test('resolveClientsQueryMode: пустой запрос по-прежнему invalid - всю базу телефонов не отдаём по ошибке в адресе', () => {
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('')), { mode: 'invalid' });
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('all=false')), { mode: 'invalid' });
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('all=1')), { mode: 'invalid' });
});

test('resolveClientsQueryMode: поиск по телефону важнее списка всей базы', () => {
  assert.deepEqual(resolveClientsQueryMode(new URLSearchParams('all=true&phone=%2B79991234567')), {
    mode: 'phone',
    phone: '+79991234567',
  });
});

test('listAllClients: строки базы превращаются в карточки списка, числа - числами, даты - строками YYYY-MM-DD', async () => {
  const fake = {
    async query() {
      return {
        rows: [
          {
            id: 'c1',
            name: 'Иван',
            phone: '+79991234567',
            no_show_streak: 0,
            visits_count: '3',            // pg отдаёт count/sum строками - проверяем приведение
            revenue: '5400',
            last_visit_date: new Date('2026-08-10T00:00:00Z'),
            comments_count: '1',
            first_visit_date: new Date('2026-06-01T00:00:00Z'),
            source: '2gis',
            last_comment: 'Просил не стричь виски машинкой',
          },
        ],
      };
    },
  };
  const [c] = await listAllClients(fake);
  assert.equal(c.visitsCount, 3);
  assert.equal(c.revenue, 5400);
  assert.equal(c.firstVisitDate, '2026-06-01');
  assert.equal(c.lastVisitDate, '2026-08-10');
  assert.equal(c.source, '2gis');
  assert.equal(c.commentsCount, 1);
  assert.equal(c.lastComment, 'Просил не стричь виски машинкой');
  assert.deepEqual(c.risk, { level: 'none', label: null });
});

test('Клиент без визитов приходит из базы нулями, а не пропадает из списка', async () => {
  const fake = {
    async query() {
      return {
        rows: [
          {
            id: 'c2', name: 'Новичок', phone: '+79990000000', no_show_streak: 0,
            visits_count: '0', revenue: '0', last_visit_date: null, comments_count: '0',
            first_visit_date: null, source: null, last_comment: null,
          },
        ],
      };
    },
  };
  const [c] = await listAllClients(fake);
  assert.equal(c.visitsCount, 0);
  assert.equal(c.revenue, 0);
  assert.equal(c.firstVisitDate, null);
  assert.equal(c.source, null);
});

test('Лимит комментария - 3000 знаков (требование заказчика 21.08.2026), и он же стоит в maxlength обоих полей', () => {
  assert.equal(BOOKING_COMMENT_MAX_LEN, 3000);
  // Числа обязаны совпадать: разойдись они, сотрудник дописал бы заметку, которую
  // сервер отвергнет уже после нажатия «Сохранить» (или наоборот - поле оборвало бы
  // текст раньше, чем это нужно серверу). Проверяем разметку обеих страниц, где это
  // поле есть: карточка записи одинакова у владельца и у администратора.
  for (const page of ['crm-owner.html', 'crm-admin.html']) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const field = html.match(/<textarea id="bkStaffComment"[^>]*>/);
    assert.ok(field, `${page}: поле комментария не найдено`);
    assert.match(field[0], new RegExp(`maxlength="${BOOKING_COMMENT_MAX_LEN}"`), `${page}: maxlength разошёлся с сервером`);
  }
});
