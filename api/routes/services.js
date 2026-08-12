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
  const result = await pool.query('SELECT id, name, category, duration_min, price, composition FROM services ORDER BY name, id');
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
  const result = await pool.query('SELECT master_id, service_id, price, duration_min FROM master_services ORDER BY master_id, service_id');
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
  const durationMin = Number.isFinite(body.durationMin) ? body.durationMin : serviceRes.rows[0].duration_min;
  if (durationMin <= 0) return sendJson(res, 400, { error: 'invalid_duration' });
  await pool.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, $3, $4)
     ON CONFLICT (master_id, service_id) DO UPDATE SET price = $3, duration_min = $4`,
    [masterId, serviceId, price, durationMin]
  );
  return sendJson(res, 200, { ok: true, enabled: true, price, durationMin });
}
