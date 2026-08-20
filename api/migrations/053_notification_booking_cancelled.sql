-- 20.08.2026, решение Влада: об отмене записи должны узнавать все, кого она касается -
-- мастер, у которого сорвался визит, владелец и администратор точки.
--
-- Новый тип, а не переписывание booking_new своим же типом: у отмены свой смысл, своя
-- иконка и свой текст сообщения клиенту («запись отменена», а не «ждём вас»). При этом
-- в ленте по-прежнему остаётся ОДНА строка на запись - прежние уведомления по этой
-- брони удаляются в тот же момент (handleBookingCancel), тем же приёмом, каким
-- перенос убирает противоположное направление (applyRescheduleNotifications).
--
-- Имя constraint не хардкодим - тот же приём, что в 019/022/032/033/037/042/051.
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
  'booking_new', 'booking_moved_out', 'booking_moved_in', 'booking_cancelled'
));
