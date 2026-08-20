-- 20.08.2026, решение Влада: раздел «Уведомления» и колокольчик - только про записи
-- клиентов. Всё остальное из ленты уходит:
--
--   'booking_reminder_15' / 'booking_start' - напоминания фонового сканера («за 15
--     минут», «время пришло»). Влад: «нужны уведомления только в момент записи, за 15
--     минут не нужно». Сам сканер снят в api/server.mjs этой же правкой - без него
--     новых строк этих типов никто не создаёт.
--   'schedule_request_new' / '..._decided' / '..._cancelled' - согласование отгулов.
--     Мастер больше не подаёт заявки вообще (форма удалена из crm-master.html,
--     роуты /schedule-requests сняты с сервера) - уведомлять не о чем.
--   'master_lost_schedule' - предупреждение владельцу при входе. Снято по решению
--     Влада вместе с остальными: график теперь меняет только владелец/администратор,
--     то есть сам источник инцидента (мастер, случайно снёсший себе график) исчез.
--   'schedule_conflict' - тип из миграции 019, живых вызовов notifyStaff с ним в коде
--     не осталось ещё до этой правки.
--
-- Остаются ровно три типа - все три про запись клиента: она появилась, ушла к другому
-- мастеру, пришла от другого мастера.
--
-- Порядок важен: сначала удаляем строки снятых типов, потом сужаем CHECK. Наоборот
-- нельзя - ALTER ... ADD CONSTRAINT проверяет уже лежащие строки и упадёт, а упавшая
-- миграция роняет весь сервер (инцидент 04.08.2026, см. CLAUDE.md).
DELETE FROM notifications WHERE type NOT IN ('booking_new', 'booking_moved_out', 'booking_moved_in');

-- Имя constraint не хардкодим - тот же приём, что в 019/022/032/033/037/042.
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name FROM pg_constraint
  WHERE conrelid = 'notifications'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%booking_new%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type in (
  'booking_new', 'booking_moved_out', 'booking_moved_in'
));

-- Таблица schedule_change_requests НЕ удаляется: это история решений по отгулам за
-- месяц работы, снос данных необратим и не требуется задачей. Роутов к ней больше нет,
-- новых строк никто не создаёт.
