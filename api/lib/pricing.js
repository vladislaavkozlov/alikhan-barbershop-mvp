// Цена визита - одна формула на весь бэкенд (Окно 59, 22.08.2026).
//
// Формула была та же и раньше («своя цена мастера в приоритете, общий прайс services -
// страховка на пару, которую не завели в master_services»), но жила локальным
// замыканием внутри computeMasterPayroll (api/routes/payroll.js) и обслуживала ровно
// одного мастера. Недополученная прибыль считает деньги по клиентам РАЗНЫХ мастеров,
// и писать для неё второй расчёт цены нельзя: расходящаяся формула в двух местах -
// ошибка, которую в этом проекте уже ловили в зарплате мастера (Окно 37). Поэтому
// резолвер вынесен сюда как есть, поведение зарплаты не изменилось - тот же приоритет,
// тот же ноль в конце, те же два запроса.
//
// masterIds - необязательное сужение выборки: зарплата спрашивает прайс одного
// мастера (как и раньше), денежная карточка - всех сразу. Пустой/непереданный список
// значит «все мастера».
export async function loadPriceResolver(client, masterIds = null) {
  const scoped = Array.isArray(masterIds) && masterIds.length > 0;
  const masterPriceRes = scoped
    ? await client.query(
        'SELECT master_id AS "masterId", service_id AS "serviceId", price FROM master_services WHERE master_id = ANY($1)',
        [masterIds]
      )
    : await client.query('SELECT master_id AS "masterId", service_id AS "serviceId", price FROM master_services');
  const basePriceRes = await client.query('SELECT id, price FROM services');

  const byPair = new Map(masterPriceRes.rows.map((r) => [`${r.masterId} ${r.serviceId}`, r.price]));
  const byService = new Map(basePriceRes.rows.map((r) => [r.id, r.price]));

  // Тот же порядок разрешения, что был в computeMasterPayroll и что стоит на фронте
  // (computePricing, assets/crm-dashboard.js): цена мастера, потом общий прайс, потом 0
  const priceOf = (masterId, serviceId) => byPair.get(`${masterId} ${serviceId}`) ?? byService.get(serviceId) ?? 0;

  // Списочная цена визита - сумма его услуг. Услуг может не быть вовсе (старая бронь
  // без booking_services): фолбэк на bookings.service_id решает вызывающий, сюда
  // приходит уже готовый список id.
  const visitPrice = (masterId, serviceIds) => (serviceIds ?? []).reduce((sum, id) => sum + Number(priceOf(masterId, id) ?? 0), 0);

  return { priceOf, visitPrice };
}
