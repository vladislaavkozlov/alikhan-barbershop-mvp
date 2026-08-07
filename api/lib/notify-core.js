// In-app уведомления - вынесено из server.mjs при декомпозиции (Этап 2
// структурного рефакторинга, 07.08.2026), код перенесён без изменений.
// Используется несколькими доменами роутов (auth, schedule, schedule-requests,
// bookings через createBookingTx, фоновый scanBookingReminders).
import { randomBytes } from 'node:crypto';
import { mastersWithWorkingSchedule } from './schedule-core.js';

// Задача 5 (Окно 14, 02.08.2026) - создаёт уведомление в личном кабинете. Уникальные
// индексы notifications_booking_dedup/notifications_schedreq_dedup (миграция 015)
// защищают от дублей при повторном вызове (например фоновый сканер + ручное
// действие в одну минуту) - ON CONFLICT DO NOTHING, не считается ошибкой.
export async function notifyStaff(
  client,
  staffId,
  type,
  { bookingId = null, scheduleRequestId = null, relatedMasterId = null, title, body = null }
) {
  await client.query(
    `INSERT INTO notifications (id, staff_id, type, booking_id, schedule_request_id, related_master_id, title, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [`ntf-${randomBytes(8).toString('hex')}`, staffId, type, bookingId, scheduleRequestId, relatedMasterId, title, body]
  );
}

// Окно 35 (06.08.2026) - чистая функция: из мастеров, которые оказывают услуги,
// отбирает тех, кого нет в scheduledMasterIds (уже посчитанном mastersWithWorkingSchedule,
// не переизобретаем вычисление). Отдельно от notifyOwnerAboutMastersMissingSchedule,
// чтобы юнит-тест не зависел от fake DB client вообще.
export function findMastersMissingSchedule(serviceMasterIds, scheduledMasterIds) {
  return serviceMasterIds.filter((id) => !scheduledMasterIds.has(id));
}

// FINAL_PRODUCT_DECISION.md MUST HAVE Epic 3 - владелец не должен узнавать о
// пропавшем графике мастера только ручной curl-проверкой (реальный инцидент с
// Мамедханом, PROJECT_UNDERSTANDING.md разд.7). Вызывается при входе владельца
// (POST /auth/login). Дедуп - постоянный уникальный индекс notifications_master_dedup
// (миграция 037, тот же приём, что notifications_schedreq_dedup) через ON CONFLICT
// DO NOTHING внутри notifyStaff - если для этого мастера уже создавали уведомление
// этого типа (когда-либо, не только непрочитанное), повторно не создаём даже если
// график успел восстановиться и снова пропасть (простое решение по Окну 35).
export async function notifyOwnerAboutMastersMissingSchedule(client, ownerId) {
  const staffRes = await client.query('SELECT id, name FROM staff WHERE employed = true AND provides_services = true');
  const serviceMasterIds = staffRes.rows.map((r) => r.id);
  const scheduledIds = await mastersWithWorkingSchedule(client, serviceMasterIds);
  const missingIds = findMastersMissingSchedule(serviceMasterIds, scheduledIds);
  const nameById = new Map(staffRes.rows.map((r) => [r.id, r.name]));
  for (const masterId of missingIds) {
    await notifyStaff(client, ownerId, 'master_lost_schedule', {
      relatedMasterId: masterId,
      title: `У мастера ${nameById.get(masterId) ?? masterId} пропал график работы`,
      body: 'Клиенты не могут записаться, пока график не будет настроен заново.',
    });
  }
}
