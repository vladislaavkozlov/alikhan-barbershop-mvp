-- Окно 40 (06.08.2026) - уборка за собой: qa-window40-owner (038_qa_window40_owner.sql)
-- использовался ровно один раз для живой curl-проверки GET /owner/alerts на реальном
-- бое - проверка прошла (реальные "хвосты" тестовых заявок id 1/3/4 на master-3
-- корректно попали в pendingRequests), аккаунт больше не нужен. У аккаунта
-- provides_services=false (как и у всех owner-аккаунтов) - никаких FK-зависимостей
-- (schedule_shifts/master_weekly_schedule/bookings/master_services) он породить не
-- мог, но DELETE идемпотентен и безопасен, даже если бы они появились.
DELETE FROM staff WHERE id = 'qa-window40-owner';
