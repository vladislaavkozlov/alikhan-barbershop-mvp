-- Окно 19 (04.08.2026) - временный тестовый логин мастера для живой curl-проверки
-- бага "пустые breaks у одобренного отгула" (ТЗ-разработчику-баги-2026-08-04.md) и
-- для CDP-проверки нового read-only календаря/графика мастера (ПРОМПТ-ОКНО-19).
-- Тот же приём, что уже применялся в 010_qa_test_account.sql (Окно 13),
-- 023_qa_window16_owner.sql (Окно 16), 025_qa_window17_owner.sql (Окно 17),
-- 028_qa_window18.sql (Окно 18) - PIN-хэш сгенерирован hashPin() из api/server.mjs,
-- не подобран под существующую учётку. Одобряет заявку qa-window18-owner (уже
-- существует, PIN известен из tools/live-verify-okno18.mjs) - не трогаем реальную
-- Елизавету (master-3).
--
-- Ничего не ссылается на этот id снаружи - можно удалить в любой момент без
-- последствий:
--   DELETE FROM staff WHERE id = 'qa-window19-master';
INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
  ('qa-window19-master', NULL, 'QA Тест Окно 19 Мастер (можно удалить)', 'master', true, true, true, 'qa-window19-master@alikhan.test', '1f05b9f8944f916dea0e072133499991:cabf742eebaeff9aca2970c231fb99a9016fcde84b9afc390d7cdebe96ce3e4f819fea068552e0b225a080cd01cb63807b212482f196af10abc089194c671e58')
ON CONFLICT (id) DO NOTHING;
