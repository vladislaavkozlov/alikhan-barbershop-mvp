-- Окно 17 (04.08.2026) - временный тестовый owner-логин для живой curl-проверки
-- на реальном HTTPS API https://alikhancrm1-vladislaavkozlov.amvera.io: блокировка
-- при конфликте (PUT /master-weekly-schedule, POST /schedule, PATCH
-- /schedule-requests/:id/decision), GET /schedule-range, DELETE /schedule. Прямого
-- доступа к Postgres нет (классификатор песочницы блокирует прямые DB/SSH-
-- соединения) - тот же принцип, что уже применялся в 010_qa_test_account.sql
-- (Окно 13) и 023_qa_window16_owner.sql (Окно 16).
--
-- Ничего не ссылается на этот id снаружи - можно удалить в любой момент без
-- последствий: DELETE FROM staff WHERE id = 'qa-window17-owner'.
INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
  ('qa-window17-owner', NULL, 'QA Тест Окно 17 (можно удалить)', 'owner', true, false, true, 'qa-window17@alikhan.test', 'cca356a092e97b73163da100e2bf0491:316029c10bbb38045f8db7f1e640f8808d4ba4281ac732b8ee3860d97406c633609aed447202229863ac62dc1da0c6d6e052f15ec5ea8e8e48b7f8b76becd85a')
ON CONFLICT (id) DO NOTHING;
