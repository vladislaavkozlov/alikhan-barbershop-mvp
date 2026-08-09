-- Окно 08.08.2026 (вечер) - Влад: Али иногда во время стрижки говорит администратору
-- "пробей по старой цене" (скидка клиенту) - до этой миграции цена записи была
-- жёстко суммой master_services.price по выбранным услугам, никак не редактируемой
-- по факту визита. actual_price - фактически взятая с клиента сумма, NULL по
-- умолчанию (значит "как обычно, по списку услуг", ни одна старая запись не меняет
-- поведение). payroll_from_actual_price - Али сам решает во "Финансы" → "Управление
-- скидками" (не жёстко зашитое решение в коде), должна ли зарплата мастера
-- считаться от фактически взятой суммы или всегда от полной списочной цены -
-- singleton-таблица (id boolean primary key + CHECK гарантируют ровно одну строку),
-- тот же приём, что уже применён у master_payroll_settings (по мастеру, не глобально).
ALTER TABLE bookings ADD COLUMN actual_price integer;

CREATE TABLE discount_settings (
  id boolean primary key default true check (id),
  payroll_from_actual_price boolean not null default false
);
INSERT INTO discount_settings (payroll_from_actual_price) VALUES (false);
