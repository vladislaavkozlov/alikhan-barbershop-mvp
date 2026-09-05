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

// Сколько визитов клиент пропустил ВНУТРИ выбранного окна (Окно 59, найдено живым
// прогоном 22.08.2026).
//
// Первая версия расчёта брала клиентов, у которых последний визит попал в период, - и
// на вкладке «Месяц» карточка систематически прятала самых пропавших: человек, который
// не приходил три месяца, в границы месяца не попадал вовсе. То есть чем дольше клиент
// потерян, тем меньше шансов было его увидеть - ровно наоборот тому, зачем эта
// карточка сделана.
//
// Правильный вопрос - не «когда он был последний раз», а «сколько его визитов должно
// было состояться в этом периоде и не состоялось». Визиты «должны» приходиться на
// last + renew, last + 2*renew и так далее; считаем те из них, что попали в окно
// [windowFrom, windowTo] и уже строго в прошлом.
export function missedVisitsInWindow(lastVisitDate, renewDays, { from, to, today }) {
  const days = renewDaysOf(renewDays);
  const limit = to && today && to > today ? today : to ?? today;
  let missed = 0;
  for (let k = 1; k <= 400; k += 1) {
    const due = daysBetween(lastVisitDate, limit) - k * days;
    if (due < 0) break; // срок ещё не наступил в пределах окна
    const dueFromStart = daysBetween(lastVisitDate, from) - k * days;
    // Визит, срок которого пришёлся раньше начала окна, считать нельзя: он был
    // потерян в прошлом периоде, и владелец уже видел его тогда
    if (dueFromStart >= 0) continue;
    missed += 1;
  }
  return missed;
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

// ── Кому и когда система пишет сама ─────────────────────────────────────────
// Решение Влада 05.09.2026: разговор после неявки (068-069) распространить на
// вторую причину потери - клиента, который не вернулся в свой срок. Здесь только
// решение «писать или нет и о чём», без SQL и без Telegram: та же граница, что у
// всего остального в этом файле - цифра, которую владелец читает как деньги, и
// сообщение, которое уходит живому человеку, не живут внутри строки запроса.

// Сколько дней у повода есть на то, чтобы быть отработанным.
//
// Окно, а не точное совпадение «сегодня ровно срок», по двум причинам. Сканер мог
// не работать (деплой, простой, выключенный канал), и человек не должен из-за
// этого выпасть молча. И главное - при первом включении механизма на живой базе
// точное совпадение дало бы ноль писем в первый день и внезапную пачку на второй.
//
// Три дня, а не тридцать: письмо «пора к нам» через месяц после наступления срока
// - это не забота, а напоминание о том, что о тебе забыли. Всё, что старше окна,
// остаётся списком для владельца: там звонит живой человек, а не бот.
export const OUTREACH_WINDOW_DAYS = 3;

// Повод написать клиенту, или null, если повода нет.
//
// Два повода и почему их именно два:
//   renew_due     - срок наступил, человек ещё не потерян. Это профилактика, и она
//                   дешевле любого возврата: деньги, которые не утекли, выгоднее
//                   денег, которые вернули;
//   renew_overdue - прошёл полный цикл сверх срока, то есть один визит уже пропущен
//                   (missedVisits === 1). Разговор здесь другой: не «пора», а
//                   «давно не были».
//
// Третьего письма нет намеренно. Человек, не ответивший дважды, третьим сообщением
// не возвращается - он отписывается. Дальше работает список владельца.
//
// cycleKey - дата повода, а не дата отправки. Она же ключ дедупа в очереди
// (миграция 070): сколько бы раз ни отработал сканер и в какой бы день ни ожила
// система, на один наступивший срок уходит одно письмо.
export function renewOutreachFor({ lastVisitDate, renewDays, todayDate, windowDays = OUTREACH_WINDOW_DAYS }) {
  const gap = daysBetween(lastVisitDate, todayDate);
  if (gap === null || gap < 0) return null;
  const days = renewDaysOf(renewDays);

  const withinWindow = (from) => gap >= from && gap < from + windowDays;
  if (withinWindow(days)) return { kind: 'renew_due', cycleKey: addDays(lastVisitDate, days) };
  if (withinWindow(days * 2)) return { kind: 'renew_overdue', cycleKey: addDays(lastVisitDate, days * 2) };
  return null;
}

// Дата 'YYYY-MM-DD' через N дней от даты. Через UTC-полночь - по той же причине,
// что и daysBetween: переход на летнее время не должен давать 23-часовые сутки.
export function addDays(dateStr, days) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}
