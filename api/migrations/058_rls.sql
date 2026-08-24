-- Мультиарендность, Фаза 3 (24.08.2026, plans/2026-08-24-multitenancy-etap-a.md).
-- Замок в базе: данные арендатора не покидают его периметр даже при ошибке в коде
-- приложения. Запрос без единого условия (`SELECT * FROM bookings`) из-под второго
-- арендатора возвращает только его строки - фильтрует не код, а сама база.
--
-- Только схема, никаких данных.
--
-- ── Почему миграция может отказаться работать ──────────────────────────────
-- Суперпользователь и роль с правом BYPASSRLS игнорируют политику всегда, даже с
-- FORCE. Положить замок на такую базу молча - худший из исходов: он выглядит
-- поставленным, тесты зелёные, а данные открыты. Поэтому миграция падает, и сервер
-- не стартует: честный отказ лучше ложной безопасности.
--
-- Практическое следствие: локальные репетиции гоняются под обычной ролью-владельцем
-- (см. tools/verify-2026-08-24-tenant-rls.mjs, он заводит такую роль сам), а не из-под
-- суперпользователя - так локальная база точнее повторяет боевую.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Пользователь % обходит защиту на уровне строк (суперпользователь или BYPASSRLS) - замок арендаторов на такой базе не действует, миграция остановлена', current_user;
  END IF;
END $$;

-- ── Арендатор текущего запроса ─────────────────────────────────────────────
-- Одна функция на все политики: правило, размноженное по двадцати местам, рано или
-- поздно разъедется. CASE, а не OR: порядок вычисления операндов в SQL не
-- гарантирован, и `'*'::int` мог бы выполниться раньше проверки на служебный
-- контекст, уронив запуск миграций.
--
-- current_setting БЕЗ второго аргумента - сознательно: без контекста запроса функция
-- падает, а не возвращает NULL. NULL здесь означает служебный контекст «вижу всё»,
-- и молча получить его из-за незаданной настройки нельзя ни при каких условиях.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS integer
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN current_setting('app.tenant_id') = '*' THEN NULL::int
              ELSE current_setting('app.tenant_id')::int END
$$;

-- ── Замок на каждой таблице данных ─────────────────────────────────────────
-- FOR ALL с USING и WITH CHECK: USING закрывает чтение, обновление и удаление,
-- WITH CHECK - вставку и результат обновления. Без WITH CHECK можно было бы
-- записать строку чужому арендатору, не видя её потом.
--
-- Справочник tenants сознательно остаётся БЕЗ замка: он читается ДО того, как
-- арендатор определён (Фаза 4 ищет по домену запроса именно в нём), клиентских
-- данных в нём нет, а замок на нём сделал бы определение арендатора невозможным.

ALTER TABLE booking_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_services FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON booking_services;
CREATE POLICY tenant_isolation ON booking_services
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bookings;
CREATE POLICY tenant_isolation ON bookings
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON clients;
CREATE POLICY tenant_isolation ON clients
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE discount_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON discount_settings;
CREATE POLICY tenant_isolation ON discount_settings
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON holidays;
CREATE POLICY tenant_isolation ON holidays
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE kv_store ENABLE ROW LEVEL SECURITY;
ALTER TABLE kv_store FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON kv_store;
CREATE POLICY tenant_isolation ON kv_store
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON locations;
CREATE POLICY tenant_isolation ON locations
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE master_payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_payroll_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON master_payroll_settings;
CREATE POLICY tenant_isolation ON master_payroll_settings
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE master_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_services FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON master_services;
CREATE POLICY tenant_isolation ON master_services
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE master_weekly_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_weekly_schedule FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON master_weekly_schedule;
CREATE POLICY tenant_isolation ON master_weekly_schedule
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notifications;
CREATE POLICY tenant_isolation ON notifications
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payroll_settings;
CREATE POLICY tenant_isolation ON payroll_settings
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sales;
CREATE POLICY tenant_isolation ON sales
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE schedule_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_breaks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schedule_breaks;
CREATE POLICY tenant_isolation ON schedule_breaks
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE schedule_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_change_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schedule_change_requests;
CREATE POLICY tenant_isolation ON schedule_change_requests
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE schedule_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_shifts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schedule_shifts;
CREATE POLICY tenant_isolation ON schedule_shifts
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON services;
CREATE POLICY tenant_isolation ON services
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY tenant_isolation ON sessions
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON staff;
CREATE POLICY tenant_isolation ON staff
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

ALTER TABLE staff_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_media FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON staff_media;
CREATE POLICY tenant_isolation ON staff_media
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());
