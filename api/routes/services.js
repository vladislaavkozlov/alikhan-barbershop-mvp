// GET /services, GET/PUT /master-services... - вынесено из server.mjs при
// декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код перенесён без
// изменений.
import { randomBytes } from 'node:crypto';
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
    `SELECT ms.master_id, ms.service_id, ms.price, ms.duration_min, ms.is_top
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
      // Топ-услуга этого мастера (20.08.2026, миграция 054). Читают оба потребителя
      // роута: карточка сотрудника в CRM (галка) и форма записи - чтобы цена и признак
      // тарифа приезжали одним запросом, а не двумя расходящимися.
      isTop: r.is_top === true,
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

// Цена мастера за услугу - те же два предиката, что у длительности (20.08.2026, топ-
// мастер: поле цены в карточке сотрудника стало редактируемым, до этого оно было
// текстом). Прежняя проверка роута - `Number.isFinite(body.price) ? body.price :
// каталог` - пропускала в базу и ноль, и минус, и 1500.5: ровно тот баг P2, который
// 15.08.2026 чинили для длительности, только про деньги.
export function isPriceOmitted(value) {
  return value === undefined;
}
export function isValidPrice(value) {
  return Number.isInteger(value) && value > 0;
}

// Галка «топ-услуга». Строгий boolean: строка "false" из формы истинна в JS, и мягкое
// приведение молча сделало бы мастера топовым на публичном сайте - то есть подняло бы
// цену клиенту без решения владельца. Ключа нет - услуга обычная (значение колонки по
// умолчанию), роут пишет строку master_services целиком.
export function normalizeIsTop(value) {
  return value === true;
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
  // Цена: либо корректная переданная, либо каталожная. Мусор в поле - 400, а не тихая
  // подмена каталожной ценой: владелец увидел бы «Сохранено» и чужую цифру в прайсе
  if (!isPriceOmitted(body.price) && !isValidPrice(body.price)) {
    return sendJson(res, 400, { error: 'invalid_price' });
  }
  const price = isPriceOmitted(body.price) ? serviceRes.rows[0].price : body.price;
  const isTop = normalizeIsTop(body.isTop);
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
    `INSERT INTO master_services (master_id, service_id, price, duration_min, is_top) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (master_id, service_id) DO UPDATE SET price = $3, duration_min = $4, is_top = $5`,
    [masterId, serviceId, price, durationMin, isTop]
  );
  return sendJson(res, 200, { ok: true, enabled: true, price, durationMin, isTop });
}

// ── Каталог услуг: создать, изменить, удалить (Окно 75, 28.08.2026) ──────────
//
// Зачем это появилось. До сегодняшнего дня каталог услуг заводился ровно один раз -
// миграцией 002_schema.sql при первой сборке системы для барбершопа Алихана. Пока
// арендатор был один, дыры не было видно. 28.08.2026 к тому же движку подключилась
// клиника Карины и упёрлась в стену: своих процедур ей завести нечем - ни в кабинете,
// ни через API. Без каталога у арендатора нет ни записи, ни расписания, ни зарплаты,
// ни аналитики, то есть системы нет вовсе. Критерий приёмки Окна 69 «клиент заводит
// процедуру сам, без разработчика» на самом деле не выполнялся: при той проверке
// услуги подкладывались в базу прямым SQL.
//
// Почему удаление честное, а не флаг «архивная». Услуга связана с историей: на неё
// ссылаются booking_services (что именно оказали клиенту) и master_services (кто её
// оказывает). Мягкое скрытие потребовало бы фильтра во всех местах выбора услуг сразу
// - на сайте записи, в форме визита, в карточке сотрудника - и первое же забытое
// место показало бы клиенту услугу, которой больше нет. Поэтому удаляем физически и
// только то, что никому не понадобилось: услуга с историей записей не удаляется, а
// получает честный отказ с числом записей. Владелец видит причину и решает сам -
// поднять цену до нуля и увести из показа мы за него не вправе.
const SERVICE_CATEGORIES = ['base', 'complex'];

function readServiceFields(body, { partial }) {
  const out = {};
  const name = body.name === undefined ? undefined : String(body.name).trim();
  if (name !== undefined) {
    if (!name || name.length > 120) return { error: 'invalid_service_name' };
    out.name = name;
  } else if (!partial) return { error: 'invalid_service_name' };

  if (body.durationMin !== undefined) {
    if (!isValidDuration(body.durationMin)) return { error: 'invalid_duration' };
    out.durationMin = body.durationMin;
  } else if (!partial) return { error: 'invalid_duration' };

  // Цена нулю равняться может: консультация бывает бесплатной, и запретить это
  // значило бы заставить клинику выдумывать цифру. Это единственное отличие от
  // isValidPrice, который стережёт цену мастера за уже оказанную услугу.
  if (body.price !== undefined) {
    if (!Number.isInteger(body.price) || body.price < 0) return { error: 'invalid_price' };
    out.price = body.price;
  } else if (!partial) return { error: 'invalid_price' };

  if (body.category !== undefined) {
    if (!SERVICE_CATEGORIES.includes(body.category)) return { error: 'invalid_category' };
    out.category = body.category;
  }

  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder) || body.sortOrder < 0) return { error: 'invalid_sort_order' };
    out.sortOrder = body.sortOrder;
  }
  return { value: out };
}

const serviceRow = (r) => ({
  id: r.id,
  name: r.name,
  category: r.category,
  durationMin: r.duration_min,
  price: r.price,
  composition: r.composition,
  sortOrder: r.sort_order,
});

export async function handleServiceCreate(req, res) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readBody(req);
  const parsed = readServiceFields(body, { partial: false });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const fields = parsed.value;
  // Идентификатор служебный: он живёт в ссылках записей и в вёрстке чекбоксов, а
  // человеку не показывается никогда. Осмысленный slug из названия здесь был бы
  // ловушкой - «Чистка зубов» и «чистка зубов» дали бы один и тот же id.
  const id = `svc-${randomBytes(9).toString('hex')}`;
  // Новая услуга встаёт в конец списка: порядок показа - решение владельца, и
  // угадывать место новой процедуры среди существующих система не должна.
  const sortOrder = fields.sortOrder ?? 999;
  const result = await pool.query(
    `INSERT INTO services (id, name, category, duration_min, price, composition, sort_order)
     VALUES ($1, $2, $3, $4, $5, NULL, $6)
     RETURNING id, name, category, duration_min, price, composition, sort_order`,
    [id, fields.name, fields.category ?? 'base', fields.durationMin, fields.price, sortOrder]
  );
  return sendJson(res, 201, { service: serviceRow(result.rows[0]) });
}

export async function handleServiceUpdate(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const id = parts[1];
  const body = await readBody(req);
  const parsed = readServiceFields(body, { partial: true });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const fields = parsed.value;
  if (!Object.keys(fields).length) return sendJson(res, 400, { error: 'nothing_to_update' });
  const map = { name: 'name', durationMin: 'duration_min', price: 'price', category: 'category', sortOrder: 'sort_order' };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (fields[key] === undefined) continue;
    values.push(fields[key]);
    sets.push(`${column} = $${values.length}`);
  }
  values.push(id);
  const result = await pool.query(
    `UPDATE services SET ${sets.join(', ')} WHERE id = $${values.length}
     RETURNING id, name, category, duration_min, price, composition, sort_order`,
    values
  );
  if (!result.rows.length) return sendJson(res, 404, { error: 'service_not_found' });
  return sendJson(res, 200, { service: serviceRow(result.rows[0]) });
}

export async function handleServiceDelete(req, res, parts) {
  const auth = await authenticate(req);
  if (!canManageStaff(auth)) return sendJson(res, 401, { error: 'unauthorized' });
  const id = parts[1];
  const used = await pool.query('SELECT COUNT(*)::int AS n FROM booking_services WHERE service_id = $1', [id]);
  if (used.rows[0].n > 0) {
    // Отказ с числом: «нельзя» без причины человек читает как поломку системы
    return sendJson(res, 409, { error: 'service_in_use', bookings: used.rows[0].n });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Назначения мастерам - не история, а настройка: они уходят вместе с услугой
    await client.query('DELETE FROM master_services WHERE service_id = $1', [id]);
    const result = await client.query('DELETE FROM services WHERE id = $1 RETURNING id', [id]);
    await client.query('COMMIT');
    if (!result.rows.length) return sendJson(res, 404, { error: 'service_not_found' });
    return sendJson(res, 200, { deleted: id });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
