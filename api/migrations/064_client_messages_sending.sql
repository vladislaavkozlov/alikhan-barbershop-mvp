-- Промежуточный статус «отправляется» (01.09.2026, найдено живым прогоном).
--
-- Что случилось. Планировщик читал очередь, отправлял и только ПОТОМ помечал
-- строку отправленной. Между чтением и пометкой оставалось окно, в которое
-- следующий тик видел то же сообщение всё ещё ждущим. Влад получил одно
-- подтверждение четыре раза - в базе так и осталось attempts = 4 на одной строке.
--
-- Почему флага в памяти процесса недостаточно. Он спасает от наложения тиков
-- внутри одного процесса, но не от второго экземпляра приложения: контейнер
-- может быть перезапущен или размножен платформой, и тогда два планировщика
-- разберут одну очередь. Отсюда решение - занимать строки в самой базе, а не
-- договариваться об этом в коде.
--
-- Строка, занятая упавшим процессом, зависла бы навсегда, поэтому у статуса есть
-- отметка времени: всё, что «отправляется» дольше пяти минут, возвращается в
-- очередь следующим тиком (lib/client-messaging.js, releaseStuck).
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name FROM pg_constraint
  WHERE conrelid = 'client_messages'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%pending%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE client_messages DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE client_messages ADD CONSTRAINT client_messages_status_check CHECK (status IN (
  'pending', 'sending', 'sent', 'failed', 'cancelled', 'skipped'
));

ALTER TABLE client_messages ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- Поиск зависших: их мало, но искать их приходится каждую минуту
CREATE INDEX IF NOT EXISTS client_messages_sending_idx
  ON client_messages (claimed_at) WHERE status = 'sending';
