-- Окно 16 (03.08.2026) - временный тестовый owner-логин для живой curl-проверки
-- нового /master-weekly-schedule через реальный HTTPS API
-- https://alikhancrm1-vladislaavkozlov.amvera.io, без прямого доступа к Postgres
-- (классификатор песочницы блокирует прямые DB/SSH-соединения - тот же принцип,
-- что уже применялся в 010_qa_test_account.sql для Окна 13).
--
-- Ничего не ссылается на этот id снаружи - можно удалить в любой момент без
-- последствий: DELETE FROM staff WHERE id = 'qa-window16-owner'.
INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
  ('qa-window16-owner', NULL, 'QA Тест Окно 16 (можно удалить)', 'owner', true, false, true, 'qa-window16@alikhan.test', 'a748856ad9d7d1200060baa8755f8ae0:704fdf3704cd7ee92c6f8845a3bac9ff5a98eaffb7dcbe93b5ad4d066224fc7d5fa82e47a1e8544de699c825f41fc9809a9c7d48ef8d864544885d1f07ce2ff1')
ON CONFLICT (id) DO NOTHING;
