// Снятие «Принимает клиентов» у сотрудника с будущими записями (13.09.2026).
//
// НАХОДКА ВЛАДЕЛЬЦА. Дословно: «поставил себе галку "принимает клиентов", сделал
// записи и убрал галку. Расписание исчезло, не уведомив о том, что я больше не
// принимаю и клиентов нужно перенести». Флаг provides_services решает состав
// расписания (mastersOf, assets/crm-calendar.js), поэтому снятая галка уносит из
// «Дня», «Недели» и «Месяца» не только человека, но и живые записи к нему - а они
// остаются в базе и клиенты всё так же придут.
//
// ЧТО СТОРОЖИТ ЭТОТ ФАЙЛ. Во-первых, арифметику: что считается «будущей записью» и
// какая из них ближайшая. Во-вторых, порядок шагов в сохранении карточки - проверка
// обязана идти ДО PUT /staff, иначе предупреждение показывается уже после того, как
// сотрудник вышел из расписания.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { futureBookingsSummary } from '../assets/crm-shared.js';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');
const humanDate = (iso) => iso.split('-').reverse().join('.');

test('сводка считает живые записи от сегодняшнего дня', () => {
  const bookings = [
    { date: '2026-09-20', startTime: '15:00', status: 'planned' },
    { date: '2026-09-14', startTime: '09:00', status: 'planned' },
    { date: '2026-09-14', startTime: '08:00', status: 'cancelled' },
    { date: '2026-09-10', startTime: '10:00', status: 'planned' },
  ];
  const svodka = futureBookingsSummary(bookings, '2026-09-13', humanDate);
  // Отменённая не считается (никто не придёт), вчерашняя не считается (уже прошла)
  assert.equal(svodka.total, 2);
  // Ближайшая - самая ранняя пара «дата + время», а не первая в ответе сервера
  assert.equal(svodka.nearest, '14.09.2026 в 09:00');
});

test('сегодняшние записи считаются будущими', () => {
  // Запись на сегодня в 18:00 - это человек, который придёт вечером: убрать его
  // сотрудника из расписания молча нельзя
  const svodka = futureBookingsSummary([{ date: '2026-09-13', startTime: '18:00', status: 'planned' }], '2026-09-13', humanDate);
  assert.equal(svodka.total, 1);
  assert.equal(svodka.nearest, '13.09.2026 в 18:00');
});

test('пусто - значит пусто, без выдуманной ближайшей', () => {
  assert.deepEqual(futureBookingsSummary([], '2026-09-13'), { total: 0, nearest: null });
  assert.deepEqual(futureBookingsSummary(null, '2026-09-13'), { total: 0, nearest: null });
  assert.deepEqual(futureBookingsSummary([{ date: '2026-09-01', startTime: '10:00', status: 'planned' }], '2026-09-13'), { total: 0, nearest: null });
});

test('секунды в ответе сервера не попадают в подпись', () => {
  const svodka = futureBookingsSummary([{ date: '2026-09-14', startTime: '09:00:00', status: 'planned' }], '2026-09-13', humanDate);
  assert.equal(svodka.nearest, '14.09.2026 в 09:00');
});

test('проверка записей идёт до сохранения карточки, а не после', async () => {
  const js = await read('assets/crm-team.js');
  const proverka = js.indexOf('budushchieZapisi(id)');
  const put = js.indexOf("apiSend(`/staff/${encodeURIComponent(id)}`, 'PUT'");
  assert.ok(proverka > 0, 'проверка будущих записей пропала из сохранения карточки');
  assert.ok(put > 0, 'сохранение карточки пропало');
  assert.ok(proverka < put, 'проверка встала после PUT - предупреждать было бы уже поздно');
});

test('предупреждение спрашивает, а не решает за владельца', async () => {
  const js = await read('assets/crm-team.js');
  // Две кнопки: настоять на своём и передумать. Молчаливый запрет был бы такой же
  // ошибкой, как молчаливое согласие - владелец вправе снять приём клиентов
  assert.ok(js.includes('data-accepts-off-yes'), 'нет кнопки «Всё равно снять»');
  assert.ok(js.includes('data-accepts-off-no'), 'нет кнопки отказа');
  // Повторное сохранение после подтверждения не должно снова упереться в проверку
  assert.ok(js.includes("card.dataset.acceptsOffConfirmed = '1'"), 'подтверждение не запоминается - будет петля');
  // Отказ возвращает галку на место: человек отказался от действия, а не от карточки
  assert.ok(/data-accepts-off-no[\s\S]{0,400}tumbler\.checked = true/.test(js), 'отказ не возвращает галку');
});

test('слова предупреждения живут в словаре', async () => {
  const terms = await read('assets/crm-terms.js');
  for (const key of ['team.acceptsOffHasBookings', 'team.acceptsOffShort', 'team.acceptsOffCheckFailed']) {
    assert.ok(terms.includes(`"${key}"`), `фраза ${key} пропала из словаря`);
  }
  // Род не назначается: сотрудник может быть и мастером, и врачом, и женщиной
  const fraza = /"team\.acceptsOffHasBookings": "([^"]+)"/.exec(terms)?.[1] ?? '';
  assert.ok(!/\bон\b|\bона\b|\bпропадёт он\b/.test(fraza), `в предупреждении назначен род: ${fraza}`);
  assert.ok(fraza.includes('{name}') && fraza.includes('{count}') && fraza.includes('{when}'), 'предупреждение не называет сотрудника, число записей и ближайшую дату');
});
