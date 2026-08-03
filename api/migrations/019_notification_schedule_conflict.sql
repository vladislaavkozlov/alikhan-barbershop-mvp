-- Влад (03.08.2026): владелец/мастер должен узнавать, если ставит перерыв/выходной
-- на время, где уже есть реальная запись клиента - иначе клиент просто не застанет
-- мастера. Новый тип уведомления поверх уже рабочей системы (015_notifications.sql).
--
-- Имя check-constraint не хардкожено ("notifications_type_check" - предсказуемое
-- имя по умолчанию для column-level check без явного CONSTRAINT-имени, но не
-- проверено вживую, а миграция без доступа к psql между сессиями падает - сервер
-- не стартует вовсе, см. api/server.mjs runMigrations) - находим реальное имя
-- через pg_constraint, чтобы DROP не зависел от угадывания.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'notifications'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%type%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type in (
  'booking_new', 'booking_reminder_15', 'booking_start',
  'schedule_request_new', 'schedule_request_decided', 'schedule_conflict'
));
