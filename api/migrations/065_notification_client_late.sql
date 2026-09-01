-- 01.09.2026, вопрос Влада на живом прогоне: «нажал, что приду, а вдруг я потом
-- задержусь?»
--
-- Дыра сценария: после подтверждения кнопки снимаются, и человек остаётся без
-- выхода. По телефону он в этой ситуации звонит и говорит «буду минут на пятнадцать
-- позже» - и это ценная информация: администратор успевает подвинуть следующего
-- или предупредить мастера. Через бота сказать это было нечем.
--
-- Отдельный тип, а не «клиент просит перенести»: смысл другой. Человек ПРИДЁТ,
-- просто позже, запись остаётся на месте, и относиться к ней надо иначе, чем к
-- просьбе о переносе.
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
  'client_wants_move', 'client_wants_cancel', 'client_will_be_late'
));
