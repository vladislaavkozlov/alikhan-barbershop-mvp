// GET /services, GET/PUT /master-services... - вынесено из server.mjs при
// декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код перенесён без
// изменений.
import { sendJson, readBody } from '../lib/http.js';
import { pool } from '../lib/db.js';
import { authenticate, requireRole } from '../lib/auth.js';
import { canManageStaff } from '../lib/permissions.js';

// ── /services - каталог, доступен любой авторизованной роли ──────────
export async function handleServicesList(req, res) {
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' });
  // Порядок - тот, в котором барбершоп продаёт услуги (services.sort_order,
  // миграция 049), не алфавит: этот же список рисуют все формы выбора в CRM.
  const result = await pool.query(
    'SELECT id, name, category, duration_min, price, composition FROM services ORDER BY sort_order, name, id'
  );
  return sendJson(
    res,
    200,
    result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      durationMin: r.duration_min,
      price: r.price,
      composition: r.composition,
    }))
  );
}

// ── /master-services - цена и длительность ПО МАСТЕРУ (Окно 10, разд.17.2 ТЗ) ──
// Один и тот же каталог услуг, разные мастера могут стоить по-разному (Елизавета
// дешевле Али/Мамедхана) - см. миграцию 004_master_prices.sql. Правка 03.08.2026:
// раньше требовал логин, "публичный сайт эти данные не запрашивает" (работал на
// статике storage.js) - это и была причина бага (клиент видел все 8 услуг у
// любого мастера, включая те, что мастер не оказывает). Теперь анонимный доступ
// разрешён так же, как уже сделано для /schedule (Окно 15) - ничего чувствительнее
// цены/длительности здесь нет, эти цифры и так были видны на сайте захардкоженными.
export async function handleMasterServicesList(req, res) {
  // JOIN только ради sort_order: строки этого роута идут в чекбоксы услуг у
  // клиента на сайте, в форме "Новая запись" и в корректировке состава записи -
  // порядок там должен совпадать с каталогом, а не с алфавитом service_id.
  const result = await pool.query(
    `SELECT ms.master_id, ms.service_id, ms.price, ms.duration_min
       FROM master_services ms JOIN services s ON s.id = ms.service_id
      ORDER BY ms.master_id, s.sort_order, s.name, s.id`
  );
  return sendJson(
    res,
    200,
    result.rows.map((r) => ({
      masterId: r.master_id,
      serviceId: r.service_id,
      price: r.price,
      durationMin: r.duration_min,
    }))
  );
}

// ── /master-services/:masterId/:serviceId - Правка 03.08.2026, только владелец.
// Раньше в карточке сотрудника были чекбоксы "какие услуги умеет" и поле
// длительности - оба были чистой декорацией (никакого fetch, см. отчёт сессии),
// хотя master_services в базе уже поддерживала ровно это с самого Окна 8. Теперь
// реально включает/выключает услугу у мастера и его личную длительность.
// enabled:false удаляет строку (мастер больше не оказывает услугу) - не бронь
// затрагивает, только каталог на будущее. enabled:true создаёт/обновляет строку,
// duration_min по умолчанию берётся из общего каталога services, если не передан.
// Чистые предикаты - тестируются без Postgres (тот же приём, что isLastOwnerDemotion
// в api/routes/staff.js). "Не передана" - только отсутствие ключа в теле запроса
// (JSON.stringify такие поля просто не отправляет). Явный null - это уже переданное
// пустое значение, то есть ошибка ввода, а не согласие на каталожную длительность;
// единственный клиент роута (assets/crm-master-services.js) null не шлёт никогда.
export function isDurationOmitted(value) {
  return value === undefined;
}
export function isValidDuration(value) {
  return Number.isInteger(value) && value > 0;
}

export async function handleMasterServiceUpdate(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const masterId = decodeURIComponent(parts[1]);
  const serviceId = decodeURIComponent(parts[2]);
  const body = await readBody(req);
  if (body.enabled === false) {
    await pool.query('DELETE FROM master_services WHERE master_id = $1 AND service_id = $2', [masterId, serviceId]);
    return sendJson(res, 200, { ok: true, enabled: false });
  }
  const serviceRes = await pool.query('SELECT price, duration_min FROM services WHERE id = $1', [serviceId]);
  if (serviceRes.rows.length === 0) return sendJson(res, 404, { error: 'service_not_found' });
  const price = Number.isFinite(body.price) ? body.price : serviceRes.rows[0].price;
  // Длительность: либо корректная переданная, либо каталожная. Прежняя проверка
  // (`Number.isFinite ? ... : каталог` + `<= 0`) ловила ровно ноль, но всё
  // некорректное непонятным образом (null, "", "abc", 1.5, -10) молча подменяла
  // каталожными 60 минутами и отвечала 200 - клиент видел успех, а в базу уезжала
  // чужая цифра. Теперь мусор в поле - это 400, а не тихая подмена
  if (!isDurationOmitted(body.durationMin) && !isValidDuration(body.durationMin)) {
    return sendJson(res, 400, { error: 'invalid_duration' });
  }
  const durationMin = isDurationOmitted(body.durationMin) ? serviceRes.rows[0].duration_min : body.durationMin;
  await pool.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, $3, $4)
     ON CONFLICT (master_id, service_id) DO UPDATE SET price = $3, duration_min = $4`,
    [masterId, serviceId, price, durationMin]
  );
  return sendJson(res, 200, { ok: true, enabled: true, price, durationMin });
}
