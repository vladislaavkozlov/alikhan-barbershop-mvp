// Недополученная прибыль: кто просрочен, кто ходит разрежённо и сколько это в рублях
// (Окно 59, 22.08.2026).
//
// Весь расчёт - чистые функции без SQL и без HTTP: SQL достаёт сырьё (визиты, сроки,
// цены), решения принимаются здесь и покрыты офлайн-тестами. Так же устроены
// percentOf/shapeSourceRows в аналитике - цифра, которую владелец читает как деньги,
// не должна жить внутри строки запроса, где её никто не проверит.
import { DEFAULT_RENEW_DAYS } from './renew-reason.js';

export { DEFAULT_RENEW_DAYS };

// Во сколько раз интервал должен превышать эталон, чтобы клиент считался разрежённым.
//
// 1.5 - это стрижка «на 4 недели», за которой человек приходит раз в 6 недель: два
// прихода вместо трёх, треть денег с этого клиента мимо кассы. Порог ниже (1.2) ловил
// бы обычный сдвиг на неделю - «не смог во вторник, пришёл в следующий»; такому
// клиенту звонить не о чем, и список бы захламился. Порог выше (2.0) оставил бы в
// разрежённых только тех, кто и так вот-вот попадёт в отвал, то есть метрика опоздала
// бы ровно на то время, ради которого она заведена.
export const SPARSE_RATIO = 1.5;

// Срок, по которому живут расчёты. Пусто - месяц: это не «оценка вместо факта», а
// тот же дефолт, что сервер ставит при причине «не обсуждали» (DEFAULT_RENEW_DAYS).
// В боевой базе после очистки пустых сроков не будет вовсе - поле обязательно при
// закрытии визита.
export function renewDaysOf(renewDays) {
  const n = Number(renewDays);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_RENEW_DAYS;
}

// Разница в днях между двумя календарными датами 'YYYY-MM-DD'. Через UTC-полночь,
// чтобы переход на летнее время не давал 23- и 25-часовых суток.
export function daysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Сколько визитов клиент уже пропустил. Визит «должен был случиться» в моменты
// last + renew, last + 2*renew и так далее; пропущены те из них, которые СТРОГО раньше
// сегодня. Ровно наступивший срок - это «пора сегодня», а не «пропустил»: считать его
// потерей значило бы записывать в убыток человека, который как раз сегодня и придёт.
export function missedVisits(lastVisitDate, renewDays, todayDate) {
  const gap = daysBetween(lastVisitDate, todayDate);
  const days = renewDaysOf(renewDays);
  if (gap === null || gap <= days) return 0;
  return Math.ceil(gap / days) - 1;
}

// Три состояния клиента - одно определение на расчёты и на интерфейс.
//
//   overdue  - срок прошёл, клиент не пришёл. Звонить
//   sparse   - приходит стабильно, но реже, чем нужно стрижке. НЕ звонить «вернитесь»,
//              а объяснить срок при следующем визите и записать сразу на выходе
//   on_track - в сроке, делать ничего не надо
//
// Разрежённость ловится с двух сторон, потому что недоработка проявляется по-разному:
// либо мастер уже записал заметно больший срок, чем сам считает правильным (клиент
// согласился ходить реже), либо согласованный срок нормальный, а по факту человек
// приходит реже него. Первое видно сразу после разговора, второе - только по истории.
export function classifyClient({ lastVisitDate, renewDays, recommendedDays, visits = 0, spanDays = null, todayDate }) {
  const days = renewDaysOf(renewDays);
  const gap = daysBetween(lastVisitDate, todayDate);
  if (gap !== null && gap > days) return 'overdue';

  const recommended = Number(recommendedDays);
  if (Number.isFinite(recommended) && recommended > 0 && days >= recommended * SPARSE_RATIO) return 'sparse';

  if (visits >= 2 && Number.isFinite(spanDays) && spanDays > 0) {
    const actualInterval = spanDays / (visits - 1);
    if (actualInterval >= days * SPARSE_RATIO) return 'sparse';
  }
  return 'on_track';
}

// Сколько визитов клиент недодал за отрезок своей истории, если сравнивать с эталонным
// сроком. Эталон - рекомендованный мастером срок, а если мастер его не называл, то
// согласованный: сравнивать не с чем, кроме той договорённости, которая есть.
//
// Считаем по интервалам, а не по числу визитов: на отрезке между первым и последним
// визитом периода их ровно visits-1, и столько же должно было уместиться по эталону.
export function shortfallVisits({ visits = 0, spanDays = null, renewDays, recommendedDays }) {
  if (!(visits >= 2) || !Number.isFinite(spanDays) || spanDays <= 0) return 0;
  const recommended = Number(recommendedDays);
  const baseline = Number.isFinite(recommended) && recommended > 0 ? recommended : renewDaysOf(renewDays);
  const expectedIntervals = Math.floor(spanDays / baseline);
  return Math.max(expectedIntervals - (visits - 1), 0);
}

// Сборка денежной карточки. На вход - уже разобранные клиенты и неявки, на выход -
// три суммы и общая.
//
// Честность подписей держится здесь же, в именах полей: lost - это потерянные деньги
// (клиент не пришёл, визит не состоялся), potential - это НЕ потеря. Клиент не обещал
// ходить чаще, он согласился на свой срок; написать «вы потеряли» на разрежённых было
// бы враньём, поэтому сумма и лежит в отдельном поле с другим именем.
//
// Нет данных - null, а не ноль (тот же принцип, что у percentOf в аналитике): «за
// период не было ни одного состоявшегося визита» и «вы ничего не потеряли» - разные
// сообщения владельцу, и первое из второго не выводится.
export function summarizeMissedProfit({ overdue = [], sparse = [], noShowAmounts = [], hasData = true }) {
  if (!hasData) {
    return { lostLapsed: null, potentialSparse: null, lostNoShow: null, total: null, counts: { overdue: 0, sparse: 0, noShow: 0 } };
  }
  const lostLapsed = overdue.reduce((sum, c) => sum + Number(c.amount ?? 0), 0);
  const potentialSparse = sparse.reduce((sum, c) => sum + Number(c.amount ?? 0), 0);
  const lostNoShow = noShowAmounts.reduce((sum, a) => sum + Number(a ?? 0), 0);
  return {
    lostLapsed,
    potentialSparse,
    lostNoShow,
    // Общая сумма сверху карточки включает потенциал: владелец смотрит на неё как на
    // «сколько денег прошло мимо», а не как на долг. Разделение потеря/потенциал
    // держат подписи строк под ней - см. assets/crm-missed-profit.js
    total: lostLapsed + potentialSparse + lostNoShow,
    counts: { overdue: overdue.length, sparse: sparse.length, noShow: noShowAmounts.length },
  };
}
