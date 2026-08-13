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
