// 05.09.2026 - кому и когда система пишет сама про возврат (миграция 070).
//
// Арифметика поводов проверяется здесь, офлайн, по той же причине, по которой
// офлайн проверяется арифметика денег: письмо уходит живому человеку, и «система
// написала не тому» стоит дороже любой ошибки в отчёте.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renewOutreachFor, addDays, OUTREACH_WINDOW_DAYS, DEFAULT_RENEW_DAYS } from '../api/lib/renew.js';

test('срок наступил сегодня - пишем «пора», ключ цикла равен дате срока', () => {
  const r = renewOutreachFor({ lastVisitDate: '2026-08-08', renewDays: 28, todayDate: '2026-09-05' });
  assert.equal(r.kind, 'renew_due');
  assert.equal(r.cycleKey, '2026-09-05');
});

test('до срока не пишем ничего', () => {
  assert.equal(renewOutreachFor({ lastVisitDate: '2026-08-08', renewDays: 28, todayDate: '2026-09-04' }), null);
  assert.equal(renewOutreachFor({ lastVisitDate: '2026-09-05', renewDays: 28, todayDate: '2026-09-05' }), null);
});

test('сканер молчал два дня - повод не потерян, он живёт окно в три дня', () => {
  for (const today of ['2026-09-05', '2026-09-06', '2026-09-07']) {
    const r = renewOutreachFor({ lastVisitDate: '2026-08-08', renewDays: 28, todayDate: today });
    assert.equal(r.kind, 'renew_due', `день ${today}`);
    // Ключ один и тот же во все дни окна - иначе один наступивший срок дал бы
    // человеку три письма подряд
    assert.equal(r.cycleKey, '2026-09-05');
  }
  assert.equal(renewOutreachFor({ lastVisitDate: '2026-08-08', renewDays: 28, todayDate: '2026-09-08' }), null);
});

test('прошёл полный цикл сверх срока - письмо другое, «давно не были»', () => {
  const r = renewOutreachFor({ lastVisitDate: '2026-07-11', renewDays: 28, todayDate: '2026-09-05' });
  assert.equal(r.kind, 'renew_overdue');
  assert.equal(r.cycleKey, '2026-09-05');
});

test('между двумя поводами тишина: человек уже получил «пора» и не ответил', () => {
  // 40 дней при сроке 28: первое окно (28-30) прошло, второе (56-58) не наступило
  assert.equal(renewOutreachFor({ lastVisitDate: '2026-07-27', renewDays: 28, todayDate: '2026-09-05' }), null);
});

test('третьего письма нет: пропавший на три цикла остаётся списком владельца', () => {
  assert.equal(renewOutreachFor({ lastVisitDate: '2026-05-01', renewDays: 28, todayDate: '2026-09-05' }), null);
  assert.equal(renewOutreachFor({ lastVisitDate: '2025-09-05', renewDays: 28, todayDate: '2026-09-05' }), null);
});

test('срок не задан - считаем по месяцу, как и вся остальная арифметика', () => {
  const r = renewOutreachFor({ lastVisitDate: '2026-08-06', renewDays: null, todayDate: '2026-09-05' });
  assert.equal(r.kind, 'renew_due');
  assert.equal(r.cycleKey, addDays('2026-08-06', DEFAULT_RENEW_DAYS));
});

test('визит в будущем или мусор в дате - молчим, а не пишем наугад', () => {
  assert.equal(renewOutreachFor({ lastVisitDate: '2026-09-30', renewDays: 28, todayDate: '2026-09-05' }), null);
  assert.equal(renewOutreachFor({ lastVisitDate: null, renewDays: 28, todayDate: '2026-09-05' }), null);
  assert.equal(renewOutreachFor({ lastVisitDate: 'вчера', renewDays: 28, todayDate: '2026-09-05' }), null);
});

test('длинный цикл ортодонта разбирается той же арифметикой', () => {
  const r = renewOutreachFor({ lastVisitDate: '2026-06-07', renewDays: 90, todayDate: '2026-09-05' });
  assert.equal(r.kind, 'renew_due');
  assert.equal(r.cycleKey, '2026-09-05');
});

test('окно поводов настраивается параметром, а не переписыванием функции', () => {
  const args = { lastVisitDate: '2026-08-08', renewDays: 28, todayDate: '2026-09-06' };
  assert.equal(renewOutreachFor({ ...args, windowDays: 1 }), null);
  assert.equal(renewOutreachFor(args).kind, 'renew_due');
  assert.equal(OUTREACH_WINDOW_DAYS, 3);
});

test('переход на летнее время не сдвигает дату повода', () => {
  // Ночь перехода в Европе - 29 марта 2026. Сутки считаются через UTC-полночь,
  // поэтому 28 дней остаются 28 днями
  assert.equal(addDays('2026-03-15', 28), '2026-04-12');
  const r = renewOutreachFor({ lastVisitDate: '2026-03-15', renewDays: 28, todayDate: '2026-04-12' });
  assert.equal(r.cycleKey, '2026-04-12');
});
