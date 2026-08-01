-- Окно 13 (01.08.2026) - временный тестовый owner-логин для живой проверки Задач
-- 2/3 этого окна (отмена с порогом 2 часа, счётчик неявок/предоплата) через реальный
-- HTTPS API https://alikhancrm1-vladislaavkozlov.amvera.io, без прямого доступа к
-- Postgres (классификатор песочницы блокирует прямые DB/SSH-соединения - см.
-- Ограничения промпта корректировки, это ожидаемо и не обходится).
--
-- Тот же паттерн, что owner-test/admin-loc1-test/admin-loc2-test в 002_schema.sql
-- ("учётки для живой проверки ролей, не выдаются за реальных людей"). Ничего не
-- ссылается на этот id снаружи - можно удалить в любой момент без последствий:
--   DELETE FROM staff WHERE id = 'qa-window13-owner';
-- PIN не секрет уровня прод-доступа (owner и так есть выше, owner-test) - если Влад
-- хочет удалить учётку после проверки, это безопасно.
INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
  ('qa-window13-owner', NULL, 'QA Тест Окно 13 (можно удалить)', 'owner', true, false, true, 'qa-window13@alikhan.test', 'c1574cc793efc0be901fffb3a5f60727:12cd2d7245cb4be9b1b2d0c5e019071cc17669aa2aa657447415c31d2ddc6567a49cedd0510fbe6a09ea046b3b16770c60736b0b4388859110f1dba04a1082d6')
ON CONFLICT (id) DO NOTHING;
