-- Окно 22 (04.08.2026) - уборка за собой: qa-window19-master (029_qa_window19_master.sql)
-- использовался для живой curl-проверки бага "пустые breaks у одобренного отгула" (Окно 19)
-- и CDP-проверки read-only календаря/графика мастера - проверка прошла, аккаунт не нужен.
--
-- ПРАВКА 04.08.2026 (Окно 23, после падения прода): первая версия этой миграции чистила
-- только schedule_shifts + master_weekly_schedule, доверившись комментарию в 029 ("ничего
-- не ссылается на этот id снаружи"). На бою это оказалось неверно - весь смысл того
-- аккаунта был в том, чтобы ПОДАТЬ и одобрить заявку на отгул, то есть строка в
-- schedule_change_requests у него была. FK там без ON DELETE CASCADE, миграция упала на
-- `DELETE FROM staff`, а упавшая миграция роняет старт сервера целиком (см. runMigrations:
-- throw err) - весь API отдавал 503. Механизм воспроизведён локально до этой правки:
--   ERROR: update or delete on table "staff" violates foreign key constraint
--          "schedule_change_requests_master_id_fkey" on table "schedule_change_requests"
--
-- Теперь чистим ВСЕ таблицы с FK на staff(id), в порядке от зависимых к владельцу.
-- Все DELETE идемпотентны (нет строк - ноль эффекта), поэтому миграция безопасна и на
-- базе, где этого аккаунта никогда не было.
--   staff(id) ссылаются: master_services, bookings, schedule_shifts (002),
--   master_payroll_settings (005), notifications (015, cascade),
--   schedule_change_requests.master_id и .decided_by (016),
--   master_weekly_schedule (022), sessions (002, cascade).

-- booking_services висит на bookings(id) - его вперёд
DELETE FROM booking_services WHERE booking_id IN (SELECT id FROM bookings WHERE master_id = 'qa-window19-master');
DELETE FROM bookings WHERE master_id = 'qa-window19-master';

-- schedule_breaks уходят каскадом за schedule_shifts (FK ON DELETE CASCADE, 002:90)
DELETE FROM schedule_shifts WHERE master_id = 'qa-window19-master';
DELETE FROM master_weekly_schedule WHERE master_id = 'qa-window19-master';
DELETE FROM master_services WHERE master_id = 'qa-window19-master';
DELETE FROM master_payroll_settings WHERE master_id = 'qa-window19-master';

-- вот эта строка и уронила прод в первой версии
DELETE FROM schedule_change_requests WHERE master_id = 'qa-window19-master';
UPDATE schedule_change_requests SET decided_by = NULL WHERE decided_by = 'qa-window19-master';

-- notifications.staff_id и sessions.staff_id - ON DELETE CASCADE, отдельный DELETE не нужен
DELETE FROM staff WHERE id = 'qa-window19-master';
