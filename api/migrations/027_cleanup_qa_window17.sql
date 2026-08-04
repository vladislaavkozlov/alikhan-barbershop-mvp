-- Окно 17 (04.08.2026) - уборка за собой: qa-window17-owner (025_qa_window17_owner.sql)
-- использовался для живой проверки блокировки при конфликте (PUT
-- /master-weekly-schedule, POST /schedule, PATCH /schedule-requests/:id/decision),
-- GET /schedule-range и DELETE /schedule на реальном бое - проверка прошла,
-- аккаунт больше не нужен. Тестовая бронь master-3 2026-08-17 14:15-15:15 уже
-- отменена через POST /bookings/:id/cancel (status='cancelled', не требует
-- миграции). Порядок важен - FK без ON DELETE CASCADE на master_id
-- (schedule_shifts, master_weekly_schedule) требует удалить дочерние строки
-- раньше staff (qa-владелец их не создавал, но чистим по тому же прецеденту).
DELETE FROM schedule_shifts WHERE master_id = 'qa-window17-owner';
DELETE FROM master_weekly_schedule WHERE master_id = 'qa-window17-owner';
DELETE FROM staff WHERE id = 'qa-window17-owner';
