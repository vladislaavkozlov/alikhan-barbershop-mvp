-- Окно 29, Задача B (05.08.2026) - уборка за собой: qa-window18-owner, qa-window18-admin
-- (028_qa_window18.sql), использовались для живой CDP/curl-проверки Недели/Месяца/Года
-- + модалки дня + "Стандартного графика" (Окно 18). Их salt:pin_hash открыто лежат в
-- публичной миграции 028 - 4-значный PIN известного scrypt-хэша перебирается офлайн
-- за секунды, это потенциальный вход в CRM. Комментарий в 028 обещал "ничего не
-- ссылается на эти id снаружи" - ровно такое же обещание в 029 уронило прод на
-- ~20 минут при уборке Окна 22 (031_cleanup_qa_window19.sql, DELETE FROM staff упал
-- на FK schedule_change_requests_master_id_fkey). Комментарию НЕ доверяем, чистим
-- ВСЕ таблицы с FK на staff(id), в порядке от зависимых к владельцу.
--
-- Полный список FK на staff(id) в этой схеме (сверено grep по всем api/migrations/*.sql,
-- 05.08.2026): master_services.master_id (002), bookings.master_id (002),
-- schedule_shifts.master_id (002, schedule_breaks каскадом за ним),
-- master_payroll_settings.master_id (005), notifications.staff_id (015, cascade),
-- schedule_change_requests.master_id и .decided_by (016), master_weekly_schedule.master_id
-- (022), sessions.staff_id (002, cascade). Отдельно проверено: schedule_recurring_rules
-- (021) FK на staff(id) имела, но сама таблица DROP'нута миграцией 022 (заменена на
-- master_weekly_schedule) - в текущей схеме её не существует, чистить нечего.
--
-- Все DELETE идемпотентны (нет строк - ноль эффекта), миграция безопасна и на базе,
-- где этих аккаунтов уже нет или никогда не было.

-- booking_services висит на bookings(id) - вперёд самих броней
DELETE FROM booking_services WHERE booking_id IN (
  SELECT id FROM bookings WHERE master_id IN ('qa-window18-owner', 'qa-window18-admin')
);
DELETE FROM bookings WHERE master_id IN ('qa-window18-owner', 'qa-window18-admin');

-- schedule_breaks уходят каскадом за schedule_shifts (FK ON DELETE CASCADE, 002:90)
DELETE FROM schedule_shifts WHERE master_id IN ('qa-window18-owner', 'qa-window18-admin');
DELETE FROM master_weekly_schedule WHERE master_id IN ('qa-window18-owner', 'qa-window18-admin');
DELETE FROM master_services WHERE master_id IN ('qa-window18-owner', 'qa-window18-admin');
DELETE FROM master_payroll_settings WHERE master_id IN ('qa-window18-owner', 'qa-window18-admin');

-- вот такая строка и уронила прод в первой версии 031 (master_id без decided_by)
DELETE FROM schedule_change_requests WHERE master_id IN ('qa-window18-owner', 'qa-window18-admin');
UPDATE schedule_change_requests SET decided_by = NULL
  WHERE decided_by IN ('qa-window18-owner', 'qa-window18-admin');

-- notifications.staff_id и sessions.staff_id - ON DELETE CASCADE, отдельный DELETE не нужен
DELETE FROM staff WHERE id IN ('qa-window18-owner', 'qa-window18-admin');
