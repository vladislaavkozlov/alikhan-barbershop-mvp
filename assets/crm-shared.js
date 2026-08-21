// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Чистые хелперы без внешних
// зависимостей, которые нужны более чем одному домену crm-auth.js (виджетам,
// дашборду, walk-in, payroll и др.) - вынесены сюда, чтобы не дублировать в
// каждом новом файле. Код перенесён 1в1, поведение не менялось.
export function el(id) {
  return document.getElementById(id);
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatMoney(value) {
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
}

// Окно 11 (найдено Владом 30.07.2026): бронь может содержать НЕСКОЛЬКО услуг -
// b.serviceIds (см. GET /bookings, server.mjs) - сумма по всем, не одной. serviceId
// (единичное значение) остаётся страховкой на случай очень старых броней без
// booking_services. priceOf передаётся снаружи - у renderLiveProof и
// renderRevenuePeriods разные замыкания с одинаковой сигнатурой (masterId, serviceId) => price.
export function bookingPrice(booking, priceOf) {
  const serviceIds = booking.serviceIds?.length ? booking.serviceIds : [booking.serviceId];
  return serviceIds.reduce((sum, id) => sum + priceOf(booking.masterId, id), 0);
}

// Правка 08.08.2026 (вечер, Влад: "ЗП мастеров должны считаться корректно от
// фактически полученных сумм") - тот же принцип, что уже применён на бэкенде
// (computeMasterPayroll, api/routes/payroll.js): для РАСЧЁТА ЗП берём booking.
// actualPrice, если владелец включил discount_settings.payrollFromActualPrice И
// для ЭТОЙ КОНКРЕТНОЙ записи фактическая сумма реально вписана - иначе (выключено,
// или не вписано) обычная bookingPrice по списку услуг, поведение не отличается от
// исходного. Для ВЫРУЧКИ бизнеса (не ЗП) везде по-прежнему используется чистая
// bookingPrice - это сознательное разделение с самого начала фичи (владелец решает
// политику именно для ЗП, выручка остаётся честной цифрой по прайсу).
export function payrollBookingAmount(booking, priceOf, payrollFromActualPrice) {
  if (payrollFromActualPrice && booking.actualPrice != null) return booking.actualPrice;
  return bookingPrice(booking, priceOf);
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// ── Карточка визита в кабинете мастера (13.08.2026) ────────────────────────────
// Комиссия мастера за конкретную запись (assets/crm-master-booking.js). Старая
// карточка #bd-1 считала её по ХАРДКОДУ имён (MASTER_COMMISSION_PCT['Елизавета'] в
// assets/mockup-crm.js) - при смене ставки или найме нового мастера цифра врала. Здесь
// ставка приходит из реальных master_payroll_settings (pctOf, тот же источник, что и
// "Моя зарплата"), а сумма - от фактической, если администратор её уже провёл.
// total === null - считать не из чего: это не "0 ₽" (тот же принцип, что у
// currentServicesTotal в assets/crm-walkin.js).
export function masterCommissionLabel({ total, pct, isOwner }) {
  if (isOwner) return { amount: null, text: 'Не начисляется - вы владелец, вся сумма остаётся в бизнесе' };
  if (total == null || pct == null) return { amount: null, text: 'Выберите услуги, чтобы увидеть комиссию' };
  const amount = Math.round((total * pct) / 100);
  return { amount, text: `${pct}% от ${formatMoney(total)}` };
}

// Правка Влада 21.08.2026 - в деньги идут ТОЛЬКО состоявшиеся визиты: "данные должны
// тянуться только по тем блокам, где оплата фактически была зафиксирована... клиент
// обслужен, окно записи зелёное. Ожидает - это только предположение, клиент и
// отменить может". Зелёная карточка в расписании - это ровно status='done'
// (.appt--done, assets/crm-calendar.js), поэтому один и тот же фильтр стоит на всех
// денежных блоках "Финансов". До этой правки в выручку и зарплату попадали и
// запланированные ('planned'), и неявки ('no_show'), и отменённые ('cancelled')
// брони - цифра на экране была прогнозом, а выглядела как факт. Тот же фильтр
// продублирован в SQL единого резолвера (computeMasterPayroll, api/routes/payroll.js).
export const PAID_STATUS = 'done';
export function paidBookings(bookings) {
  return (bookings ?? []).filter((b) => b?.status === PAID_STATUS);
}

// Ставка "% от выручки", пока владелец не сохранил свою - 0 у всех, включая
// владельца и управляющего.
//
// 21.08.2026, вторая правка Влада. Сначала дефолт для владельца и управляющего был
// 100% ("пусть там сейчас по умолчанию стоит 100%"), но Влад сам пересобрал логику
// вслух и оказался прав: процент - это доля выручки, которая УХОДИТ мастеру, а
// остаток остаётся бизнесу. У наёмного мастера 100% значит "он забрал всё, бизнесу
// ноль" (так и есть у Мамедхана). У владельца та же цифра означала бы, что его
// собственные стрижки записаны в расход бизнеса и обнуляют "Чистый доход" - хотя
// эти деньги и так его. Правильная ставка владельцу - 0: тогда его выручка целиком
// остаётся в чистом доходе, а деньги мастера со 100% в прибыль не попадают.
//
// Ноль здесь ещё и честнее выдуманного числа: придумывать за Алихана процент новому
// сотруднику нельзя, поэтому его карточка показывает 0 и подпись "ставка ещё не
// задана", пока владелец не впишет своё. Один и тот же дефолт идёт и в поле
// карточки, и в расчёт суммы - цифра на экране всегда соответствует полю
export const DEFAULT_PCT = 0;
export function defaultPctFor(_staff) {
  return DEFAULT_PCT;
}

// Кто попадает в блок "Зарплаты мастеров": все, у кого включено "Принимает клиентов",
// независимо от роли - владелец и управляющий тоже стригут и получают те же поля,
// что мастер. До 21.08.2026 список был захардкожен тремя id, и новый сотрудник в
// "Финансы" не попадал вовсе (правка Влада, п.6)
export function payrollStaff(staffList) {
  return (staffList ?? []).filter((s) => s?.providesServices);
}

// ── Просыпающийся сервер (21.08.2026, Влад: «жму войти - не заходит, обновил
// несколько раз и тогда зашло»; «клиенты очень долго грузятся») ────────────────
// Бэкенд на Amvera периодически уходит в спячку и первый запрос после простоя либо
// висит десятки секунд, либо обрывается совсем: замер 21.08.2026 - обычный ответ
// 170 мс, но в одном окне 17 000 мс, в другом полный обрыв по таймауту. Для человека
// это выглядело как «CRM не пускает», хотя ни пароль, ни код ни при чём - помогало
// именно повторное нажатие, то есть повторный запрос.
//
// Поэтому повтор делает сама система, а не человек. Повторяем ТОЛЬКО то, что
// безопасно повторить: обрыв сети (запрос не дошёл) и ответы «сервер временно
// недоступен» (502/503/504). Ответ 4xx - осмысленный отказ сервера (неверный PIN,
// нет прав), его повторять бессмысленно и вредно: три попытки подряд с неверным
// PIN выглядят в логах как подбор пароля.
// 429 «слишком много запросов» тоже повторяем: его отдаёт не наше приложение (в коде
// такого ответа нет вовсе), а защита хостинга, когда в кабинет одновременно заходят
// несколько сотрудников салона с одного интернета. Это временный отказ, ровно как
// спящий контейнер, и человек лечил его тем же способом - жал «войти» ещё раз
const WAKEUP_STATUSES = new Set([429, 502, 503, 504]);

export async function fetchWithWakeup(url, init, options = {}) {
  const {
    attempts = 3,
    onWait = null,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    // Пауза растёт: 1.5 с, потом 4 с. Холодный старт контейнера занимает секунды,
    // и три попытки подряд без пауз просто потратили бы их впустую
    delays = [1500, 4000],
  } = options;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const isLast = attempt === attempts - 1;
    try {
      const res = await fetchImpl(url, init);
      if (!WAKEUP_STATUSES.has(res.status) || isLast) return res;
    } catch (err) {
      lastError = err;
      if (isLast) throw err;
    }
    onWait?.(attempt + 1);
    await sleep(delays[Math.min(attempt, delays.length - 1)]);
  }
  throw lastError ?? new Error('unreachable');
}
