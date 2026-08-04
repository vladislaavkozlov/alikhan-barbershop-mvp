-- Окно 16 (03.08.2026) - уборка за собой: qa-window16-owner (023_qa_window16_owner.sql)
-- использовался ровно один раз для живой curl-проверки PUT/GET
-- /master-weekly-schedule и /schedule (недельный график побеждается разовой
-- правкой) - проверка прошла, аккаунт и тестовые данные больше не нужны.
-- Порядок важен - FK без ON DELETE CASCADE на master_id (schedule_shifts,
-- master_weekly_schedule) требует удалить дочерние строки раньше staff.
DELETE FROM schedule_shifts WHERE master_id = 'qa-window16-owner'; -- каскадом уносит schedule_breaks
DELETE FROM master_weekly_schedule WHERE master_id = 'qa-window16-owner';
DELETE FROM staff WHERE id = 'qa-window16-owner';
