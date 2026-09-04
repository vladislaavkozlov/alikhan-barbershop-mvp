-- 04.09.2026, решение Влада по карточке «Неявки» в «Недополученной прибыли».
--
-- На самой крупной потере экрана продукт молчал: сумма есть, делать нечего. Схема,
-- которую выбрал владелец: бот пишет не пришедшему сам, а администратор звонит уже
-- тому, кто ответил - прогретому, а не холодному.
--
-- Вопрос владельца на разборе схемы: «а если клиент не ответит - игнорить его?».
-- Нет: список неявок показывает состояние каждого, и молчащий из него не исчезает,
-- а получает свою подпись «написали, молчит N дней». Чтобы это состояние было чем
-- считать, нужен факт ответа - его и хранят эти две колонки.
--
-- Ответ живёт на брони, а не на клиенте: человек мог не прийти дважды, и ответ на
-- сентябрьский пропуск ничего не говорит про августовский. Отдельной таблицы не
-- заводим - у факта одна строка-владелец, и это сама неявка.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS noshow_reply text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS noshow_reply_at timestamptz;

-- wants_time - «да, подберите время», это и есть очередь на прозвон;
-- not_now - «пока не планирую», такому звонить не надо, но и терять его из виду
-- нельзя: сумма осталась потерянной, просто действие по ней другое
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_noshow_reply_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_noshow_reply_check
  CHECK (noshow_reply IS NULL OR noshow_reply IN ('wants_time', 'not_now'));

-- Новый вид письма в очереди сообщений (lib/client-messaging.js). Набор видов в
-- 062_client_messaging.sql закрыт проверкой, поэтому её пересобираем: письмо после
-- неявки - это не напоминание о будущем визите, а разговор про уже пропущенный
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name FROM pg_constraint
  WHERE conrelid = 'client_messages'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%booking_confirm%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE client_messages DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE client_messages ADD CONSTRAINT client_messages_kind_check CHECK (kind IN (
  'booking_confirm', 'reminder_24h', 'reminder_2h', 'review_request', 'no_show_followup'
));
