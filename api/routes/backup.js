// Своя резервная копия базы (24.08.2026, plans/2026-08-24-backup-prod.md).
//
// Зачем через приложение. База Amvera недоступна снаружи: DB_HOST - внутреннее имя
// кластера, с личной машины оно не резолвится вовсе. Ни pg_dump, ни psql. Дотянуться
// до данных может только сам сервер, поэтому копию снимает он.
//
// Роут отдаёт ВСЮ базу целиком, включая телефоны и историю клиентов, - это самая
// лакомая цель во всём API. Отсюда три замка:
//   1. выключен, пока не задан BACKUP_TOKEN (как LIVE_EVENTS) - на проде включается
//      переменной в панели ровно на время снятия копии;
//   2. роль owner (проверяет реестр роутов) - и этого мало;
//   3. отдельный секрет в заголовке, сравнение устойчиво к подбору по времени.
// Отказ выглядит как 404 - несуществующий роут не подсказывает, что тут что-то есть.
import { timingSafeEqual } from 'node:crypto';
import { pool, runInTenant } from '../lib/db.js';
import { SYSTEM_TENANT } from '../lib/tenant-context.js';
import { sendJson } from '../lib/http.js';
import { authenticate } from '../lib/auth.js';

// Порядок важен для восстановления: сначала то, на что ссылаются, потом ссылающиеся.
// tenants первым - без справочника ни одна строка не ляжет, внешний ключ не на что
// положить.
//
// sessions в копию НЕ входит сознательно: это живые токены доступа в кабинеты, и
// файлу на диске им лежать незачем. Потеря невелика - после восстановления
// сотрудники просто войдут заново, данных салона в этой таблице нет.
export const BACKUP_TABLES = [
  'tenants',
  'locations',
  'staff',
  'services',
  'clients',
  'bookings',
  'booking_services',
  'sales',
  'schedule_shifts',
  'schedule_breaks',
  'schedule_change_requests',
  'master_services',
  'master_payroll_settings',
  'master_weekly_schedule',
  'notifications',
  'staff_media',
  'holidays',
  'kv_store',
  'payroll_settings',
  'discount_settings',
];

// Секрет приезжает HTTP-заголовком, поэтому он обязан быть из латиницы и цифр:
// кириллицу в заголовок положить нельзя, браузер и Node просто не дадут.
export function backupAllowed(auth, providedToken, expectedToken) {
  if (!expectedToken) return false;
  if (!auth || auth.role !== 'owner') return false;
  if (typeof providedToken !== 'string' || providedToken.length === 0) return false;
  const provided = Buffer.from(providedToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  // Разная длина - сравнивать нечего, но и ранний выход по длине ничего не выдаёт:
  // длина секрета и так не тайна
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export async function handleBackup(req, res) {
  const auth = await authenticate(req);
  if (!backupAllowed(auth, req.headers['x-backup-token'], process.env.BACKUP_TOKEN)) {
    return sendJson(res, 404, { error: 'route_not_found' });
  }
  // Служебный контекст: копия должна содержать ВСЕХ арендаторов. Из-под конкретного
  // арендатора замок отдал бы только его строки, и копия была бы тихо неполной
  const tables = {};
  await runInTenant(SYSTEM_TENANT, async () => {
    for (const table of BACKUP_TABLES) {
      tables[table] = (await pool.query(`SELECT * FROM ${table}`)).rows;
    }
  });
  const rowCount = Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length]));
  return sendJson(res, 200, { takenAt: new Date().toISOString(), rowCount, tables });
}
