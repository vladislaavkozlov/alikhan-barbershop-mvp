-- ПУТЬ ОТКАТА Этапа A мультиарендности (24.08.2026).
-- Отменяет миграции 057_tenants.sql, 058_rls.sql, 059_tenant_domains.sql и
-- возвращает схему ровно к состоянию 056.
--
-- ЛЕЖИТ ВНЕ api/migrations/ СОЗНАТЕЛЬНО: файл в той папке авто-раннер применил бы
-- при ближайшем старте сервера, то есть откат случился бы сам собой.
--
-- ── ПОРЯДОК ОТКАТА: СНАЧАЛА КОД, ПОТОМ БАЗА ────────────────────────────────
-- 1. Откатить код бэкенда на коммит до Этапа A и дождаться живого /health.
-- 2. Только после этого выполнить этот файл.
-- Обратный порядок не работает: новый код без арендатора в базе падает на каждом
-- запросе (это его сознательное поведение, fail-closed), и салон встанет.
--
-- ── ГРАНИЦА ПРИМЕНИМОСТИ ───────────────────────────────────────────────────
-- Откат возможен, ПОКА арендатор один. Как только у второго клиента появились свои
-- строки, снятие колонки арендатора смешает два салона в один - записи, клиенты и
-- деньги Карины окажутся в базе Алихана. Поэтому файл сам отказывается работать,
-- если находит хоть одну чужую строку: в такой ситуации откатывают код, а схему
-- оставляют как есть (старый код с колонкой tenant_id работает - она с умолчанием).
-- Пока замок стоит, любой запрос к данным требует контекста арендатора. Откат
-- работает от служебного имени - так же, как миграции.
SET app.tenant_id = '*';

DO $$
DECLARE
  foreign_rows integer := 0;
  t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id <> 1', t) INTO STRICT foreign_rows;
    IF foreign_rows > 0 THEN
      RAISE EXCEPTION 'В таблице % есть % строк второго арендатора - откат схемы смешал бы салоны. Откатывайте только код', t, foreign_rows;
    END IF;
  END LOOP;
END $$;

-- ── 058: снять замок ───────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS app_current_tenant();

-- ── 057: вернуть прежние ключи и индексы ───────────────────────────────────
DROP INDEX IF EXISTS staff_tenant_email_key;
ALTER TABLE staff ADD CONSTRAINT staff_email_key UNIQUE (email);

DROP INDEX IF EXISTS clients_tenant_phone_key;
CREATE UNIQUE INDEX clients_phone_key ON clients (phone);

DROP INDEX IF EXISTS schedule_shifts_tenant_master_date_key;
ALTER TABLE schedule_shifts ADD CONSTRAINT schedule_shifts_master_id_date_key UNIQUE (master_id, date);

DROP INDEX IF EXISTS staff_one_protected_owner_idx;
CREATE UNIQUE INDEX staff_one_protected_owner_idx ON staff (protected_owner) WHERE protected_owner = true;

DROP INDEX IF EXISTS notifications_booking_dedup;
CREATE UNIQUE INDEX notifications_booking_dedup ON notifications (staff_id, type, booking_id) WHERE booking_id IS NOT NULL;
DROP INDEX IF EXISTS notifications_schedreq_dedup;
CREATE UNIQUE INDEX notifications_schedreq_dedup ON notifications (staff_id, type, schedule_request_id) WHERE schedule_request_id IS NOT NULL;
DROP INDEX IF EXISTS notifications_master_dedup;
CREATE UNIQUE INDEX notifications_master_dedup ON notifications (staff_id, type, related_master_id) WHERE related_master_id IS NOT NULL;

ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_pkey;
ALTER TABLE holidays ADD PRIMARY KEY (date);
ALTER TABLE kv_store DROP CONSTRAINT IF EXISTS kv_store_pkey;
ALTER TABLE kv_store ADD PRIMARY KEY (key);
ALTER TABLE payroll_settings DROP CONSTRAINT IF EXISTS payroll_settings_pkey;
ALTER TABLE payroll_settings ADD PRIMARY KEY (id);
ALTER TABLE discount_settings DROP CONSTRAINT IF EXISTS discount_settings_pkey;
ALTER TABLE discount_settings ADD PRIMARY KEY (id);

DROP INDEX IF EXISTS bookings_master_date_idx;
CREATE INDEX bookings_master_date_idx ON bookings (master_id, date);
DROP INDEX IF EXISTS bookings_client_history_idx;
CREATE INDEX bookings_client_history_idx ON bookings (client_id, date, start_time);
DROP INDEX IF EXISTS notifications_bell_idx;
CREATE INDEX notifications_bell_idx ON notifications (staff_id, created_at DESC) WHERE dismissed_at IS NULL;
DROP INDEX IF EXISTS notifications_staff_unread_idx;
CREATE INDEX notifications_staff_unread_idx ON notifications (staff_id, read_at, created_at DESC);
DROP INDEX IF EXISTS staff_media_staff_sort_idx;
CREATE INDEX staff_media_staff_sort_idx ON staff_media (staff_id, kind, sort_order, created_at);
DROP INDEX IF EXISTS schedule_change_requests_master_idx;
CREATE INDEX schedule_change_requests_master_idx ON schedule_change_requests (master_id, status);
DROP INDEX IF EXISTS schedule_change_requests_status_idx;
CREATE INDEX schedule_change_requests_status_idx ON schedule_change_requests (status, created_at);
DROP INDEX IF EXISTS staff_created_at_idx;
CREATE INDEX staff_created_at_idx ON staff (created_at, id);

-- Индексы, которых до Этапа A не было вовсе
DROP INDEX IF EXISTS bookings_tenant_date_idx;
DROP INDEX IF EXISTS services_tenant_sort_idx;
DROP INDEX IF EXISTS locations_tenant_idx;
DROP INDEX IF EXISTS sessions_tenant_idx;
DROP INDEX IF EXISTS schedule_breaks_tenant_shift_idx;
DROP INDEX IF EXISTS master_services_tenant_idx;
DROP INDEX IF EXISTS master_weekly_schedule_tenant_idx;
DROP INDEX IF EXISTS master_payroll_settings_tenant_idx;
DROP INDEX IF EXISTS booking_services_tenant_idx;
DROP INDEX IF EXISTS sales_tenant_booking_idx;

-- ── Снять колонку арендатора и справочник ──────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP COLUMN tenant_id', t);
  END LOOP;
END $$;
DROP TABLE IF EXISTS tenants;

-- ── Забыть применённые миграции ────────────────────────────────────────────
-- Иначе при возврате нового кода авто-раннер сочтёт их применёнными и не накатит
DELETE FROM schema_migrations WHERE filename IN ('057_tenants.sql', '058_rls.sql', '059_tenant_domains.sql');
