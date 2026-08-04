-- Окно 18 (04.08.2026) - временные тестовые логины владельца и администратора для
-- живой CDP/curl-проверки Недели/Месяца/Года + модалки дня + "Стандартного графика"
-- на реальном HTTPS API https://alikhancrm1-vladislaavkozlov.amvera.io. Прямого
-- доступа к Postgres нет (классификатор песочницы блокирует прямые DB/SSH-
-- соединения) - тот же принцип, что уже применялся в 010_qa_test_account.sql
-- (Окно 13), 023_qa_window16_owner.sql (Окно 16) и 025_qa_window17_owner.sql
-- (Окно 17). PIN-хэши сгенерированы этим же окном (hashPin из api/server.mjs),
-- не подобраны под существующие учётки - обе учётки одноразовые и удаляемые.
--
-- Ничего не ссылается на эти id снаружи - можно удалить в любой момент без
-- последствий:
--   DELETE FROM staff WHERE id IN ('qa-window18-owner', 'qa-window18-admin');
INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
  ('qa-window18-owner', NULL, 'QA Тест Окно 18 Владелец (можно удалить)', 'owner', true, false, true, 'qa-window18-owner@alikhan.test', 'b042b76c71336d33cb6a65f2e687bf19:94916dc5063c3525fa05bcdd00b6e13d1a1af3b214dc34358698d9f1600ecec0de811fca4012bc908b566536722ab69e6d9d06af85add86e792d77b5fa896da4'),
  ('qa-window18-admin', 1, 'QA Тест Окно 18 Админ (можно удалить)', 'admin', true, false, true, 'qa-window18-admin@alikhan.test', 'fa157e6f0be7bb26620b35dff86add6d:1b3f4995ef1fbe6d4d6ebc19e5d7832831c8a475ee7da49c4456624fe45cfc400c01a817f98f44caf68b357839dea02cdddee2eff2d076ef6baf1f204b57be1a')
ON CONFLICT (id) DO NOTHING;
