-- Окно 23 (04.08.2026) - отмена уже ОДОБРЕННОЙ многодневной заявки на отгул/отпуск
-- целиком (PATCH /schedule-requests/:id/cancel). До этой миграции статус заявки мог
-- быть только pending/approved/rejected (миграция 016) - то есть после точечного
-- сброса одной даты кнопкой "Сбросить к стандартному" (DELETE /schedule) заявка
-- продолжала числиться approved, хотя её эффект был стёрт: история врала владельцу.
-- Новый терминальный статус 'cancelled' = "была одобрена, потом отменена целиком,
-- ни одна дата диапазона больше не заблокирована".
--
-- Имя constraint не хардкодим (тот же приём, что в 019/022) - в проде и на локальных
-- тестовых базах оно могло быть сгенерировано Postgres по-разному.
DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'schedule_change_requests'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE schedule_change_requests DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE schedule_change_requests ADD CONSTRAINT schedule_change_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
