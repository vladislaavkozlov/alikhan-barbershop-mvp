-- Окно 23 (04.08.2026), найдено живым прогоном - уведомление мастеру "твой одобренный
-- отгул отменён" молча НЕ создавалось. Причина: уникальный индекс
-- notifications_schedreq_dedup (staff_id, type, schedule_request_id) из миграции 015 -
-- на эту же заявку у мастера уже лежало уведомление 'schedule_request_decided'
-- (момент одобрения), и повторная вставка того же типа гасилась ON CONFLICT DO NOTHING
-- внутри notifyStaff. То есть отмена проходила, а мастер об этом не узнавал никак.
--
-- Отдельный тип 'schedule_request_cancelled' решает это по существу, а не обходом:
-- дедуп-индекс включает type, поэтому отмена больше не сталкивается с одобрением, и
-- при этом остаётся защита от дублей уже самой отмены (повторный cancel и так отбит
-- 409 not_approved, но индекс страхует).
--
-- Имя constraint не хардкодим - тот же приём, что в 019/022/032.
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
  'booking_new', 'booking_reminder_15', 'booking_start',
  'schedule_request_new', 'schedule_request_decided', 'schedule_conflict',
  'schedule_request_cancelled'
));
