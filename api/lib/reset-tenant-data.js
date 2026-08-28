// Разовый сброс рабочих данных арендатора перед передачей кабинета заказчику
// (27.08.2026, задача «удалить все тестовые данные»).
//
// Зачем это существует. База Amvera живёт во внутренней сети: ни psql, ни pg_dump
// снаружи не дотянутся, а привилегированного роута в API нет и сознательно не
// заводится (api/lib/provision-tenant.js). Остаётся тот же механизм, которым уже
// заводится арендатор: переменная в панели плюс перезапуск. Отсюда и требования -
// идемпотентность, отказ при малейшей неоднозначности и снимок для отката.
//
// Что удаляется. Только работа салона: записи, их состав и допродажи, клиенты,
// уведомления, разовые смены и перерывы, заявки на график. Состав команды, услуги,
// цены, компетенции, фото, точки, ставки, скидки и производственный календарь не
// трогаются ни одной строкой.
//
// Почему в контексте АРЕНДАТОРА, а не в служебном '*'. Цена ошибки в номере
// арендатора - стёртая чужая клиника. В контексте арендатора замок из миграции
// 058_rls.sql физически не даёт увидеть чужие строки, а значит и удалить их.
// Служебный контекст этот замок снимает, и здесь он не нужен ни для чего.
import { pool, runInTenant } from './db.js';
import { writeWeeklySchedule } from './schedule-core.js';

export class ResetSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResetSpecError';
  }
}

const fail = (message, variable = 'RESET_TENANT_DATA') => {
  throw new ResetSpecError(`${variable}: ${message}`);
};

// Отказ уже во время операции: приставку RESET_TENANT_DATA к нему добавит обёртка,
// второй раз её тут писать незачем
const refuse = (message) => {
  throw new ResetSpecError(message);
};

// Порядок безопасен по внешним ключам: сначала ссылающиеся, потом те, на кого
// ссылаются. notifications.booking_id объявлен ON DELETE CASCADE (миграция 015), но
// полагаться на каскад здесь нельзя: уведомление может висеть и без записи, а счётчик
// удалённого должен быть честным по каждой таблице.
export const RESET_TABLES = [
  'notifications',
  'sales',
  'booking_services',
  'bookings',
  'clients',
  'schedule_breaks',
  'schedule_shifts',
  'schedule_change_requests',
];

// Таблицы, которые операция трогает, но НЕ очищает: недельный график она не удаляет
// насовсем, а заменяет целиком (writeWeeklySchedule стирает прежние строки того, кому
// пишет, а строки тех, кого нет в штате, снимаются отдельным запросом). Прежний график
// после такой замены не восстановим ничем, если его не снять заранее - поэтому он
// входит в снимок наравне с очищаемыми таблицами, но в список удаления не входит.
export const SNAPSHOT_EXTRA_TABLES = ['master_weekly_schedule'];

// Что кладётся в снимок отката целиком: восемь очищаемых таблиц плюс недельный график
export const SNAPSHOT_TABLES = [...RESET_TABLES, ...SNAPSHOT_EXTRA_TABLES];

// Вертикали, для которых сброс вообще разрешён. Второй рубеж поверх сверки имени:
// имя защищает от опечатки в номере арендатора, но не от согласованной ошибки
// «правильный номер клиники плюс правильное имя клиники», набранной с чужого листка.
// Барбершоп передаётся заказчику, клиника Карины - нет, и вертикаль это различает
// там, где имя и номер уже сошлись.
export const RESET_ALLOWED_VERTICALS = ['barbershop'];

// График первого дня. Один и тот же на все семь дней недели - ровно то, что просил
// владелец: с 08:00 до 20:00, перерыв с 13:00 до 14:00. Дальше салон правит его сам
// из кабинета, это стартовое состояние, а не константа в коде.
export const RESET_SCHEDULE = {
  workStart: '08:00',
  workEnd: '20:00',
  breakStart: '13:00',
  breakEnd: '14:00',
};

export const resetScheduleRows = () =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, isWorking: true, ...RESET_SCHEDULE }));

export const snapshotKey = (label) => `data-reset:${label}`;

// Заявка приезжает одной строкой: <номер арендатора>:<точное имя>:<метка>
//
// Имя в середине сознательно. Номер арендатора - это одна цифра, и опечатка в ней
// стирает не тот салон; имя рядом с номером превращает опечатку в отказ, а не в
// катастрофу. Метка стоит последней и служит двум вещам сразу: ключом снимка отката
// и признаком «этот сброс уже выполнен».
//
// Кавычки и восклицательный знак панель Amvera не принимает вовсе (находка 26.08.2026,
// api/lib/provision-tenant.js). Здесь их не может быть по построению формата, а чтобы
// человек не искал причину молчаливого отказа панели, они отсекаются явной проверкой.
export function parseResetSpec(raw, variable = 'RESET_TENANT_DATA') {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (/["'!]/.test(value)) {
    fail('в значении есть кавычка или восклицательный знак - панель Amvera такие значения не принимает. Формат: 1:Название салона:metka-sbrosa', variable);
  }
  const parts = value.split(':');
  if (parts.length < 3) {
    fail(`значение «${value}» не похоже на заявку. Формат: <номер арендатора>:<точное название>:<метка>, например 1:Барбершоп Алихан:peredacha-zakazchiku-2026-08-27`, variable);
  }
  const tenantId = parts[0].trim();
  const label = parts[parts.length - 1].trim();
  // Имя собирается обратно из середины: в названии заведения двоеточие возможно,
  // и терять на нём часть названия нельзя - расхождение с базой остановит операцию
  const tenantName = parts.slice(1, -1).join(':').trim();
  if (!/^\d+$/.test(tenantId)) fail(`номер арендатора «${parts[0]}» - не число. Барбершоп Алихан это арендатор 1`, variable);
  if (!tenantName) fail('название арендатора пустое, а сверка с базой по нему и держит всю операцию', variable);
  // Метка уезжает в ключ kv_store и в лог: только латиница, цифры, дефис и точка.
  // Пробел или кириллица в ключе - это ключ, который потом не набрать руками
  if (!/^[a-z0-9.-]+$/.test(label)) {
    fail(`метка «${label}» годится только из латиницы, цифр, точки и дефиса, например peredacha-zakazchiku-2026-08-27`, variable);
  }
  return { tenantId: Number(tenantId), tenantName, label };
}

// Что именно произойдёт - человеческими словами, до всякого перезапуска
export function describeResetSpec(spec) {
  return [
    `Арендатор: ${spec.tenantId}, название сверяется дословно: «${spec.tenantName}»`,
    `Метка сброса: ${spec.label} (ключ снимка отката в kv_store: ${snapshotKey(spec.label)})`,
    `Очищается: ${RESET_TABLES.join(', ')}`,
    `В снимок отката попадают: ${SNAPSHOT_TABLES.join(', ')}`,
    `График всем сотрудникам в штате: 7 дней, ${RESET_SCHEDULE.workStart}-${RESET_SCHEDULE.workEnd}, перерыв ${RESET_SCHEDULE.breakStart}-${RESET_SCHEDULE.breakEnd}`,
  ].join('\n');
}

// ── Сама операция ───────────────────────────────────────────────────────────
//
// Одна транзакция целиком (её открывает runInTenant). Половина сброса - записи
// удалены, график не записан - хуже, чем несделанный сброс: разбирать это пришлось бы
// руками в базе, к которой снаружи не подключиться.
//
// Снимок пишется ДО удаления и в той же транзакции. Снимок, снятый после удаления,
// пуст по построению, а снятый отдельной транзакцией может разъехаться с тем, что
// реально удалено.
export async function resetTenantData(spec, out = console) {
  return runInTenant(spec.tenantId, async () => {
    const tenant = await pool.query('SELECT id, name, vertical FROM tenants WHERE id = $1', [spec.tenantId]);
    if (tenant.rows.length === 0) refuse(`арендатора ${spec.tenantId} в базе нет. Ничего не удалено`);
    const actualName = tenant.rows[0].name;
    if (actualName !== spec.tenantName) {
      refuse(`арендатор ${spec.tenantId} называется «${actualName}», а в переменной указано «${spec.tenantName}». Ничего не удалено: цена ошибки в номере арендатора - стёртые данные чужого салона`);
    }
    // Второй рубеж. Сверка имени ловит опечатку в номере, но не ловит согласованную
    // ошибку: номер клиники и имя клиники, аккуратно списанные с чужого листка, друг
    // с другом сойдутся. Вертикаль ловит именно этот случай - передаётся заказчику
    // барбершоп, и ничего кроме барбершопа сброс не чистит
    const actualVertical = tenant.rows[0].vertical;
    if (!RESET_ALLOWED_VERTICALS.includes(actualVertical)) {
      refuse(`арендатор ${spec.tenantId} «${actualName}» имеет вертикаль «${actualVertical ?? '(не задана)'}», а сброс разрешён только для: ${RESET_ALLOWED_VERTICALS.join(', ')}. Ничего не удалено`);
    }

    const key = snapshotKey(spec.label);
    const already = await pool.query('SELECT updated_at FROM kv_store WHERE key = $1', [key]);
    if (already.rows.length > 0) {
      out.log(`Сброс с меткой ${spec.label} уже выполнен (${already.rows[0].updated_at}) - ничего не удалялось. Переменную RESET_TENANT_DATA можно убрать из панели`);
      return { applied: false, tenantId: spec.tenantId, label: spec.label, deleted: null, scheduled: 0 };
    }

    // Снимок отката. Лежит в той же базе и у того же арендатора: внешний файл здесь
    // не поможет - обратно в боевую базу его залить нечем (tools/restore-backup.mjs
    // подключается к Postgres напрямую, а снаружи это невозможно)
    //
    // master_weekly_schedule лежит в снимке рядом с очищаемыми таблицами, хотя в
    // список удаления не входит: операция заменяет недельный график целиком, и без
    // снимка прежние часы работы салона не вернуть ничем
    const snapshot = {};
    for (const table of SNAPSHOT_TABLES) {
      snapshot[table] = (await pool.query(`SELECT * FROM ${table} WHERE tenant_id = $1`, [spec.tenantId])).rows;
    }
    await pool.query(
      'INSERT INTO kv_store (tenant_id, key, value, updated_at) VALUES ($1, $2, $3, now())',
      [spec.tenantId, key, JSON.stringify({ label: spec.label, tenantId: spec.tenantId, takenAt: new Date().toISOString(), tables: snapshot })]
    );

    // Условие по арендатору стоит явно, хотя замок из 058_rls.sql чужие строки и так
    // не показывает. Два независимых рубежа вместо одного: замок держит даже при
    // ошибке здесь, условие держит даже на базе, где замок почему-то снят
    const deleted = {};
    for (const table of RESET_TABLES) {
      const res = await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [spec.tenantId]);
      deleted[table] = res.rowCount ?? 0;
    }

    // График пишется ПОСЛЕ удаления записей, и это не порядок ради порядка:
    // PUT /master-weekly-schedule отказывает с 409 schedule_conflict, когда новый
    // график задевает живые брони (api/routes/schedule.js). Тем же концом смотрит и
    // здравый смысл - график первого дня не должен спорить с чужими тестовыми записями
    const staff = await pool.query(
      'SELECT id, name, role FROM staff WHERE tenant_id = $1 AND employed = true ORDER BY name, id',
      [spec.tenantId]
    );
    // Недельный график уволенного - такой же след тестового периода, как и записи, а
    // writeWeeklySchedule чистит строки только тех, кому пишет. Без этой строки в
    // таблице остались бы дни людей, которых в штате нет, и «чистое расписание»
    // оказалось бы чистым только на вид
    const staleSchedule = await pool.query(
      `DELETE FROM master_weekly_schedule
        WHERE tenant_id = $1
          AND master_id NOT IN (SELECT id FROM staff WHERE tenant_id = $1 AND employed = true)`,
      [spec.tenantId]
    );

    const rows = resetScheduleRows();
    for (const person of staff.rows) {
      await writeWeeklySchedule(pool, person.id, rows);
    }

    out.log(`Сброс данных арендатора ${spec.tenantId} «${actualName}», метка ${spec.label}`);
    for (const table of RESET_TABLES) out.log(`  ${table}: удалено строк ${deleted[table]}`);
    out.log(`  master_weekly_schedule: снято строк графика у тех, кого в штате нет: ${staleSchedule.rowCount ?? 0}`);
    out.log(`  график ${RESET_SCHEDULE.workStart}-${RESET_SCHEDULE.workEnd} с перерывом ${RESET_SCHEDULE.breakStart}-${RESET_SCHEDULE.breakEnd} записан сотрудникам в штате: ${staff.rows.length}`);
    out.log(`  снимок для отката лежит в kv_store, ключ ${key}, таблиц в нём ${SNAPSHOT_TABLES.length}, включая прежний недельный график (строк ${snapshot.master_weekly_schedule.length})`);
    out.log(`  снимок держит полные строки клиентов с телефонами: когда заказчик подтвердит первый день, снимите его переменной RESET_TENANT_DATA_DROP_SNAPSHOT=${spec.tenantId}:${actualName}:${spec.label}`);
    out.log('Уберите переменную RESET_TENANT_DATA из панели Amvera и перезапустите приложение - повторный старт с той же меткой ничего не удалит, но переменной в панели там не место');
    return {
      applied: true,
      tenantId: spec.tenantId,
      label: spec.label,
      deleted,
      snapshotTables: SNAPSHOT_TABLES.length,
      scheduleSnapshotRows: snapshot.master_weekly_schedule.length,
      staleScheduleRemoved: staleSchedule.rowCount ?? 0,
      scheduled: staff.rows.length,
    };
  });
}

// Точка входа для старта приложения. НИКОГДА не бросает - тот же контракт, что у
// provisionTenantFromEnv: опечатка в переменной не должна ронять живой салон. Отказ
// здесь не полумера: транзакция откатывается целиком, в базе не меняется ничего.
export async function resetTenantDataFromEnv(env = {}, out = console) {
  let spec;
  try {
    spec = parseResetSpec(env.RESET_TENANT_DATA);
  } catch (error) {
    out.error(`${error.message}. Данные НЕ тронуты, приложение работает как прежде`);
    return null;
  }
  if (!spec) return null;
  try {
    return await resetTenantData(spec, out);
  } catch (error) {
    out.error(`RESET_TENANT_DATA: сброс не выполнен - ${error.message}. В базе ничего не удалено, приложение работает как прежде`);
    return null;
  }
}

// ── Снятие снимка отката ────────────────────────────────────────────────────
//
// Снимок нужен ровно до того момента, когда заказчик подтвердил первый день: дальше
// это копия персональных данных (полные строки clients с телефонами), которая лежит в
// боевой базе без срока годности. Штатный способ убрать её - тем же каноническим
// механизмом, что и сам сброс: переменная в панели плюс перезапуск.
//
//   RESET_TENANT_DATA_DROP_SNAPSHOT=<номер арендатора>:<точное имя>:<метка сброса>
//
// Формат тот же и сверки те же, включая вертикаль: удалять строку чужого арендатора
// эта операция не должна ровно по той же причине, по которой не должна её создавать.
// Идемпотентность здесь бесплатная - снимка уже нет, значит убирать нечего.
export const DROP_SNAPSHOT_VARIABLE = 'RESET_TENANT_DATA_DROP_SNAPSHOT';

export async function dropResetSnapshot(spec, out = console) {
  return runInTenant(spec.tenantId, async () => {
    const tenant = await pool.query('SELECT id, name, vertical FROM tenants WHERE id = $1', [spec.tenantId]);
    if (tenant.rows.length === 0) refuse(`арендатора ${spec.tenantId} в базе нет. Снимок не тронут`);
    const actualName = tenant.rows[0].name;
    if (actualName !== spec.tenantName) {
      refuse(`арендатор ${spec.tenantId} называется «${actualName}», а в переменной указано «${spec.tenantName}». Снимок не тронут`);
    }
    const actualVertical = tenant.rows[0].vertical;
    if (!RESET_ALLOWED_VERTICALS.includes(actualVertical)) {
      refuse(`арендатор ${spec.tenantId} «${actualName}» имеет вертикаль «${actualVertical ?? '(не задана)'}», а снятие снимка разрешено только для: ${RESET_ALLOWED_VERTICALS.join(', ')}. Снимок не тронут`);
    }

    const key = snapshotKey(spec.label);
    const res = await pool.query('DELETE FROM kv_store WHERE tenant_id = $1 AND key = $2', [spec.tenantId, key]);
    const removed = res.rowCount ?? 0;
    if (removed === 0) {
      out.log(`Снимок ${key} у арендатора ${spec.tenantId} «${actualName}» не найден - убирать нечего. Возможно, он уже снят`);
    } else {
      out.log(`Снимок ${key} у арендатора ${spec.tenantId} «${actualName}» удалён: строк ${removed}. Персональных данных прошлого периода в базе больше нет`);
      out.log('ВНИМАНИЕ: откат сброса этим снимком больше невозможен - на диске остаётся только независимая копия прода');
    }
    out.log(`Уберите переменную ${DROP_SNAPSHOT_VARIABLE} из панели Amvera и перезапустите приложение`);
    return { dropped: removed > 0, removed, tenantId: spec.tenantId, label: spec.label, key };
  });
}

// Тот же контракт, что у resetTenantDataFromEnv: НИКОГДА не бросает. Кривое значение
// переменной не должно ронять живой салон - тем более ради уборки служебной строки
export async function dropResetSnapshotFromEnv(env = {}, out = console) {
  let spec;
  try {
    spec = parseResetSpec(env[DROP_SNAPSHOT_VARIABLE], DROP_SNAPSHOT_VARIABLE);
  } catch (error) {
    out.error(`${error.message}. Снимок не тронут, приложение работает как прежде`);
    return null;
  }
  if (!spec) return null;
  try {
    return await dropResetSnapshot(spec, out);
  } catch (error) {
    out.error(`${DROP_SNAPSHOT_VARIABLE}: снимок не снят - ${error.message}. В базе ничего не изменено, приложение работает как прежде`);
    return null;
  }
}
