-- 01.09.2026, Волна 1: клиент отвечает на напоминание кнопкой в боте, и этот ответ
-- должен доехать до людей в заведении, а не остаться флагом в базе.
--
-- «Приду» отдельным типом не заводится: подтверждение и так красит плашку в
-- расписании (bookings.client_confirmed), отдельное уведомление на каждое «ок»
-- превратило бы ленту администратора в поток шума. А вот «перенести» и «отменить»
-- требуют живого действия человека: бот не переносит и не отменяет запись сам.
-- Сознательное решение первой версии - клиент просит, администратор решает.
--
-- Два типа, а не один: администратор должен видеть суть, не открывая карточку.
-- Имя constraint не хардкодим - тот же приём, что в 019/022/032/033/037/042/051/053.
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
  'booking_new', 'booking_moved_out', 'booking_moved_in', 'booking_cancelled',
  'client_wants_move', 'client_wants_cancel'
));
