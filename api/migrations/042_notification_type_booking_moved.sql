-- Окно 54 (10.08.2026), Задача C - решение Влада по открытому вопросу Задачи B:
-- при переносе записи (PATCH /bookings/:id/reschedule) мастер должен узнать, что
-- запись у него ушла/пришла, а не обнаруживать это по календарю. Создание брони
-- уведомляет с Окна 14, у переноса аналога не было.
--
-- Два отдельных типа, а не один общий: у старого и нового мастера принципиально
-- разные сообщения ("запись ушла, слот освободился" против "у тебя новая запись,
-- перенесена с ..."), и разный смысл клика. Один тип с разным body сэкономил бы
-- строку в списке и стоил бы честности иконки/поведения на фронте (Окно 55).
--
-- booking_moved_out - старому мастеру, booking_moved_in - новому и админам точки.
--
-- Имя constraint не хардкодим - тот же приём, что в 019/022/032/033/037.
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
  'schedule_request_cancelled', 'master_lost_schedule',
  'booking_moved_out', 'booking_moved_in'
));
