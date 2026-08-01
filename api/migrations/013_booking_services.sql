-- Окно 11 (найдено Владом 30.07.2026, ТЗ-разработчику-баги-2026-07-30.md): клиент
-- на публичном сайте мог выбрать только ОДНУ услугу за визит - карточки услуг
-- визуально были чекбоксами, вели себя как радиокнопки. Ограничение было не только
-- во фронтенде: bookings.service_id хранил ровно одно значение.
--
-- booking_services - таблица связи many-to-many. bookings.service_id НЕ удаляем
-- (могут быть боевые брони со старой схемой) - просто новые брони создаются только
-- через таблицу связи, service_id для них остаётся NULL (server.mjs).
CREATE TABLE booking_services (
  booking_id text REFERENCES bookings(id) ON DELETE CASCADE,
  service_id text REFERENCES services(id),
  PRIMARY KEY (booking_id, service_id)
);

-- Бэкфилл: старые однo-услужные брони переносим в таблицу связи, чтобы весь код
-- читал брони ОДНИМ способом (через booking_services), не разветвлял логику на
-- "старые брони - смотри service_id, новые - смотри таблицу связи".
INSERT INTO booking_services (booking_id, service_id)
SELECT id, service_id FROM bookings WHERE service_id IS NOT NULL
ON CONFLICT DO NOTHING;
