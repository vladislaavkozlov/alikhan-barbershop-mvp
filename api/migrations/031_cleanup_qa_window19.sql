-- Окно 22 (04.08.2026) - уборка за собой: qa-window19-master (029_qa_window19_master.sql)
-- использовался для живой curl-проверки бага "пустые breaks у одобренного отгула" и
-- CDP-проверки read-only календаря/графика мастера (Окно 19) - проверка прошла,
-- аккаунт больше не нужен. Комментарий в 029 сам подтверждает, что снаружи на этот id
-- ничего не ссылается (ни schedule_shifts, ни master_weekly_schedule, ни bookings) -
-- защитные DELETE ниже по тому же прецеденту, что 027_cleanup_qa_window17.sql (порядок
-- важен, если бы строки всё же были - FK без ON DELETE CASCADE на master_id).
DELETE FROM schedule_shifts WHERE master_id = 'qa-window19-master';
DELETE FROM master_weekly_schedule WHERE master_id = 'qa-window19-master';
DELETE FROM staff WHERE id = 'qa-window19-master';
