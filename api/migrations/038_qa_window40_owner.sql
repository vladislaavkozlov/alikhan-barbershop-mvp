-- Окно 40 (06.08.2026) - QA-логин владельца для живой CDP-проверки дашборда
-- "Сегодня" (GET /owner/alerts). Свой salt+hash через hashPin() из server.mjs
-- (scrypt, 64 байта) для СВОЕГО выбранного PIN, не подбор чужого (тот же приём,
-- что уже применён окнами 13/16/17/18 - reference_barbershop-crm-tech.md,
-- "Создавать НОВЫЕ QA-логины с собственным PIN"). Реальный владелец (Алихан) не
-- трогается - отдельная учётка, планово удаляется следующим окном/уборкой.
INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
  ('qa-window40-owner', NULL, 'QA Тест Окно 40 Владелец (можно удалить)', 'owner', true, false, true, 'qa-window40-owner@alikhan.test', '87b82adcec81fe98d7567d2f4ab0a2f9:c46f16fd8c19063bc7b2ac3fa6dfe983d1320c72ada9c3fddf9df2bd2fa3053bf5702456affe9b08ade41f11f1868e84a4bfa7c49b165d57ce802dee2f74d6d7')
ON CONFLICT (id) DO NOTHING;
