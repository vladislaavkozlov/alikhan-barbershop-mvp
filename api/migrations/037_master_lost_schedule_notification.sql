-- Окно 35 (06.08.2026) - алерт владельцу "у мастера пропал график работы"
-- (FINAL_PRODUCT_DECISION.md, MUST HAVE, Epic 3). Реальный инцидент - Мамедхан был
-- невидим для записи несколько дней (hasWorkingSchedule: false), и никто не узнал,
-- пока не проверили curl'ом вручную (PROJECT_UNDERSTANDING.md, разд.7).
--
-- related_master_id - новый столбец, отдельный от booking_id/schedule_request_id
-- (миграция 015) - уведомление о мастере не привязано ни к брони, ни к заявке на
-- график. Уникальный частичный индекс - тот же приём дедупликации, что уже применён
-- для booking_id/schedule_request_id (015) и для типа отмены (033, Окно 23) - раз
-- создали уведомление про конкретного мастера этого типа, повторно не создаём
-- (ON CONFLICT DO NOTHING внутри notifyStaff), даже если график у него сломается
-- снова позже - простое решение по Окну 35, не требуется активно гасить/сбрасывать
-- при восстановлении графика.
ALTER TABLE notifications ADD COLUMN related_master_id text REFERENCES staff(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX notifications_master_dedup ON notifications (staff_id, type, related_master_id) WHERE related_master_id IS NOT NULL;

ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type in (
  'booking_new', 'booking_reminder_15', 'booking_start',
  'schedule_request_new', 'schedule_request_decided', 'schedule_conflict',
  'schedule_request_cancelled', 'master_lost_schedule'
));
