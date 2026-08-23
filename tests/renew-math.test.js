// Окно 59 (22.08.2026) - арифметика недополученной прибыли. Ровно те решения, из
// которых потом складываются рубли на экране владельца: кто просрочен, кто ходит
// разрежённо, сколько визитов человек пропустил и почему «нет данных» это не ноль.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renewDaysOf,
  daysBetween,
  missedVisits,
  classifyClient,
  shortfallVisits,
  summarizeMissedProfit,
  SPARSE_RATIO,
  DEFAULT_RENEW_DAYS,
} from '../api/lib/renew.js';
import { normalizeRenewInput, RENEW_REASON_KEYS } from '../api/lib/renew-reason.js';

test('срок: пустое поле читается как месяц, не как ноль', () => {
  assert.equal(renewDaysOf(28), 28);
  assert.equal(renewDaysOf(null), DEFAULT_RENEW_DAYS);
  assert.equal(renewDaysOf(0), DEFAULT_RENEW_DAYS);
  assert.equal(renewDaysOf('abc'), DEFAULT_RENEW_DAYS);
});

test('дни между датами не сбиваются на переходе летнего времени', () => {
  assert.equal(daysBetween('2026-08-01', '2026-08-29'), 28);
  assert.equal(daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.equal(daysBetween(null, '2026-08-01'), null);
});

test('пропущенные визиты: ровно наступивший срок ещё не потеря', () => {
  // срок 28 дней, прошло ровно 28 - человеку пора сегодня, он ничего не пропустил
  assert.equal(missedVisits('2026-08-01', 28, '2026-08-29'), 0);
  // прошёл день сверх срока - один визит уже мимо
  assert.equal(missedVisits('2026-08-01', 28, '2026-08-30'), 1);
  // два срока подряд - пропущен один (второй наступает ровно сегодня)
  assert.equal(missedVisits('2026-06-01', 28, '2026-07-27'), 1);
  // почти три срока - пропущено два
  assert.equal(missedVisits('2026-06-01', 28, '2026-08-15'), 2);
});

test('состояние клиента считается по ЕГО сроку, а не по общему месяцу', () => {
  // Срок 14 дней, прошло 20 - просрочен, хотя по старому общему порогу «месяц» он
  // считался бы благополучным
  assert.equal(
    classifyClient({ lastVisitDate: '2026-08-02', renewDays: 14, todayDate: '2026-08-22' }),
    'overdue'
  );
  // Срок 60 дней, прошло 40 - в сроке, хотя по общему месяцу числился бы пропавшим
  assert.equal(
    classifyClient({ lastVisitDate: '2026-07-13', renewDays: 60, todayDate: '2026-08-22' }),
    'on_track'
  );
});

test('разрежённый: согласованный срок заметно больше рекомендованного', () => {
  // мастер считает правильным 28 дней, договорились на 56 - это ровно 2x, выше порога
  assert.equal(
    classifyClient({ lastVisitDate: '2026-08-20', renewDays: 56, recommendedDays: 28, todayDate: '2026-08-22' }),
    'sparse'
  );
  // 28 против 35 - сдвиг на неделю, это ещё не разрежённость (1.25 < 1.5)
  assert.equal(
    classifyClient({ lastVisitDate: '2026-08-20', renewDays: 35, recommendedDays: 28, todayDate: '2026-08-22' }),
    'on_track'
  );
  assert.equal(SPARSE_RATIO, 1.5);
});

test('разрежённый: фактический интервал устойчиво больше согласованного срока', () => {
  // договорились на 28 дней, а по факту 4 визита за 180 дней - интервал 60 дней
  assert.equal(
    classifyClient({ lastVisitDate: '2026-08-20', renewDays: 28, visits: 4, spanDays: 180, todayDate: '2026-08-22' }),
    'sparse'
  );
  // 4 визита за 90 дней - интервал 30, это норма при сроке 28
  assert.equal(
    classifyClient({ lastVisitDate: '2026-08-20', renewDays: 28, visits: 4, spanDays: 90, todayDate: '2026-08-22' }),
    'on_track'
  );
});

test('просроченность важнее разрежённости: звонить, а не объяснять', () => {
  const state = classifyClient({
    lastVisitDate: '2026-05-01',
    renewDays: 56,
    recommendedDays: 28,
    todayDate: '2026-08-22',
  });
  assert.equal(state, 'overdue');
});

test('недобор визитов считается от рекомендованного срока, а без него - от согласованного', () => {
  // 3 визита за 180 дней (2 интервала), рекомендовано 28 - уместилось бы 6
  assert.equal(shortfallVisits({ visits: 3, spanDays: 180, renewDays: 60, recommendedDays: 28 }), 4);
  // мастер срок не называл - сравниваем с согласованным (60): 3 интервала минус 2
  assert.equal(shortfallVisits({ visits: 3, spanDays: 180, renewDays: 60, recommendedDays: null }), 1);
  // один визит - интервалов нет, недобора не посчитать
  assert.equal(shortfallVisits({ visits: 1, spanDays: 180, renewDays: 28 }), 0);
  // ходит чаще эталона - недобора нет, отрицательных визитов не бывает
  assert.equal(shortfallVisits({ visits: 10, spanDays: 90, renewDays: 28, recommendedDays: 28 }), 0);
});

test('итог карточки: разрежённость лежит отдельно от потерь', () => {
  const out = summarizeMissedProfit({
    overdue: [{ amount: 2000 }, { amount: 1500 }],
    sparse: [{ amount: 4000 }],
    noShowAmounts: [1800],
  });
  assert.equal(out.lostLapsed, 3500);
  assert.equal(out.potentialSparse, 4000);
  assert.equal(out.lostNoShow, 1800);
  assert.equal(out.total, 9300);
  assert.deepEqual(out.counts, { overdue: 2, sparse: 1, noShow: 1 });
});

test('нет данных за период - прочерк, а не ноль рублей', () => {
  const out = summarizeMissedProfit({ hasData: false });
  assert.equal(out.total, null);
  assert.equal(out.lostLapsed, null);
  assert.equal(out.potentialSparse, null);
  assert.equal(out.lostNoShow, null);
});

test('срок с причиной «не обсуждали» всегда месяц, что бы ни прислал фронт', () => {
  const out = normalizeRenewInput({ reason: 'not_discussed', days: 120 });
  assert.equal(out.ok, true);
  assert.equal(out.value.days, DEFAULT_RENEW_DAYS);
  assert.equal(out.value.reason, 'not_discussed');
});

test('срок не принимается без причины, вне границ и с чужим ключом', () => {
  assert.equal(normalizeRenewInput(null).error, 'renew_required');
  assert.equal(normalizeRenewInput({ days: 28 }).error, 'invalid_renew_reason');
  assert.equal(normalizeRenewInput({ reason: 'вымысел', days: 28 }).error, 'invalid_renew_reason');
  assert.equal(normalizeRenewInput({ reason: 'recommended', days: 3 }).error, 'invalid_renew_days');
  assert.equal(normalizeRenewInput({ reason: 'recommended', days: 900 }).error, 'invalid_renew_days');
  assert.equal(normalizeRenewInput({ reason: 'recommended', days: 28.5 }).error, 'invalid_renew_days');
});

test('рекомендованный срок сохраняется честно, мусор в нём не роняет закрытие визита', () => {
  const ok = normalizeRenewInput({ reason: 'price', days: 56, recommendedDays: 28, note: '  клиент упомянул отпуск  ' });
  assert.equal(ok.value.recommendedDays, 28);
  assert.equal(ok.value.note, 'клиент упомянул отпуск');
  const garbage = normalizeRenewInput({ reason: 'price', days: 56, recommendedDays: 'полтора месяца' });
  assert.equal(garbage.ok, true);
  assert.equal(garbage.value.recommendedDays, null);
});

test('список причин закрыт и совпадает с тем, что показывает фронт', () => {
  assert.deepEqual(RENEW_REASON_KEYS, ['recommended', 'hair', 'price', 'schedule', 'not_discussed']);
});
