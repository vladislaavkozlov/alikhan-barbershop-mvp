// In-app уведомления - вынесено из server.mjs при декомпозиции (Этап 2
// структурного рефакторинга, 07.08.2026), код перенесён без изменений.
// Используется несколькими доменами роутов (auth, schedule, schedule-requests,
// bookings через createBookingTx, фоновый scanBookingReminders).
import { randomBytes } from 'node:crypto';
import { mastersWithWorkingSchedule } from './schedule-core.js';
// Уведомление на телефон (Окно 73, 28.08.2026). Импорт здесь, а не в вызывающих
// роутах, намеренно: любое уведомление, попавшее в колокольчик, должно попасть и
// на телефон - иначе нашёлся бы путь, по которому одно есть, а другого нет.
import { deliverPushLater } from './push-delivery.js';

// Задача 5 (Окно 14, 02.08.2026) - создаёт уведомление в личном кабинете. Уникальные
// индексы notifications_booking_dedup/notifications_schedreq_dedup (миграция 015)
// защищают от дублей при повторном вызове (например фоновый сканер + ручное
// действие в одну минуту) - ON CONFLICT DO NOTHING, не считается ошибкой.
//
// refresh (Окно 54, 10.08.2026, Задача C) - для событий, которые могут ПОВТОРИТЬСЯ по
// одной и той же брони с новым содержанием: перенос записи. Дедуп-индекс
// notifications_booking_dedup включает (staff_id, type, booking_id), поэтому второй
// перенос той же брони тому же мастеру молча гасился бы, а первое уведомление
// осталось бы висеть с устаревшим временем - то есть врать. Ровно этой болезнью уже
// болел 'schedule_request_cancelled' (см. миграцию 033, найдено живым прогоном Окна
// 23), только там лечили отдельным типом - здесь тип не помогает, потому что
// повторяется САМ тип. Обновляем текст, поднимаем наверх списка (created_at, сортировка
// в handleNotificationsList) и снова помечаем непрочитанным: повторный перенос это
// новая информация, а не дубль. Дефолт false - поведение всех существующих вызовов
// (booking_new, напоминания, заявки на график) не меняется ни на байт.
export async function notifyStaff(
  client,
  staffId,
  type,
  { bookingId = null, scheduleRequestId = null, relatedMasterId = null, title, body = null, refresh = false }
) {
  const params = [`ntf-${randomBytes(8).toString('hex')}`, staffId, type, bookingId, scheduleRequestId, relatedMasterId, title, body];
  if (!refresh) {
    const inserted = await client.query(
      `INSERT INTO notifications (id, staff_id, type, booking_id, schedule_request_id, related_master_id, title, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      params
    );
    // Только если строка действительно появилась. При повторном вызове по той же
    // брони (фоновый сканер плюс ручное действие в одну минуту) ON CONFLICT молча
    // ничего не вставляет - телефон в этом случае звонить не должен, иначе человек
    // получит два одинаковых уведомления на одно событие.
    if (inserted.rowCount > 0) deliverPushLater(staffId, { title, body });
    return;
  }
  // Таргет конфликта назван явно (частичный индекс требует повторить его предикат) -
  // DO UPDATE без таргета Postgres не принимает. refresh осмыслен только для событий
  // по брони, поэтому bookingId обязателен.
  if (!bookingId) throw new Error('notifyStaff: refresh требует bookingId');
  // dismissed_at сбрасывается вместе с read_at (20.08.2026): человек мог убрать строку
  // из колокольчика, разобравшись с прежним состоянием записи, - а перенос или отмена
  // это НОВАЯ информация о ней, и прятать её за прошлое решение нельзя. Строка
  // возвращается в колокольчик так же, как возвращается в непрочитанные.
  await client.query(
    `INSERT INTO notifications (id, staff_id, type, booking_id, schedule_request_id, related_master_id, title, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, staff_id, type, booking_id) WHERE booking_id IS NOT NULL
     DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, created_at = now(),
                   read_at = NULL, dismissed_at = NULL`,
    params
  );
  // Обновление (перенос записи) - это новая информация, а не дубль: строка
  // возвращается в непрочитанные, значит и телефон должен зазвонить снова
  deliverPushLater(staffId, { title, body });
}

// Окно 35 (06.08.2026) - чистая функция: из мастеров, которые оказывают услуги,
// отбирает тех, кого нет в scheduledMasterIds (уже посчитанном mastersWithWorkingSchedule,
// не переизобретаем вычисление). Отдельно от notifyOwnerAboutMastersMissingSchedule,
// чтобы юнит-тест не зависел от fake DB client вообще.
export function findMastersMissingSchedule(serviceMasterIds, scheduledMasterIds) {
  return serviceMasterIds.filter((id) => !scheduledMasterIds.has(id));
}

// notifyOwnerAboutMastersMissingSchedule удалена 20.08.2026: уведомление
// 'master_lost_schedule' снято из ленты (миграция 051 убрала тип из CHECK), а функция
// без него не просто бесполезна - её вызов уронил бы INSERT на constraint. Расчёт
// «кто без графика» жив в findMastersMissingSchedule выше и кормит баннер «Нет
// рабочего графика» через GET /owner/alerts.
