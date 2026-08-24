-- Мультиарендность, Фаза 2 (24.08.2026, plans/2026-08-24-multitenancy-etap-a.md).
-- Справочник арендаторов и признак принадлежности во всех таблицах данных.
--
-- Только схема, никаких QA-фикстур (инцидент 04.08.2026). Единственная вставка -
-- строка самого справочника: барбершоп Алихана как арендатор №1, без неё внешний
-- ключ на tenants не на что было бы навесить.
--
-- Поправка к плану по факту сверки со схемой (24.08.2026): таблиц данных не 14, как
-- считалось при исследовании, а 20. Список ниже не набран руками - он сверяется
-- тестом с тем, что реально создают миграции 001-056 (tests/api.tenant-schema.test.js).
--
-- Как переезжают боевые строки. Колонка добавляется с DEFAULT 1: все существующие
-- строки Алихана получают арендатора мгновенно, без UPDATE на миллионы строк и без
-- долгой блокировки. Только ПОСЛЕ этого дефолт меняется на арендатора текущего
-- запроса - иначе строки второго арендатора молча уезжали бы Алихану.

CREATE TABLE IF NOT EXISTS tenants (
  id serial PRIMARY KEY,
  name text NOT NULL,
  -- Домены арендатора (Фаза 4): по заголовку запроса определяется, чей это кабинет,
  -- отсюда же берётся список разрешённых источников для CORS. На этой фазе пусто -
  -- боевые домены проставляются осознанно, выдумывать их здесь нечего.
  domains text[] NOT NULL DEFAULT '{}',
  -- Вертикаль (барбершоп / клиника / ...) - словарь терминов и флаги модулей поверх
  -- неё появятся на Этапе B. Здесь только само поле, чтобы не переделывать справочник
  vertical text NOT NULL DEFAULT 'barbershop',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name, vertical) VALUES (1, 'Барбершоп Алихан', 'barbershop')
  ON CONFLICT (id) DO NOTHING;
-- Следующий арендатор получает 2, а не спотыкается об уже занятую единицу
SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1));

-- ── Признак принадлежности: 20 таблиц данных ────────────────────────────────
ALTER TABLE booking_services ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE discount_settings ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE master_payroll_settings ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE master_services ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE master_weekly_schedule ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE payroll_settings ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE schedule_breaks ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE schedule_change_requests ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE services ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);
ALTER TABLE staff_media ADD COLUMN IF NOT EXISTS tenant_id integer NOT NULL DEFAULT 1 REFERENCES tenants(id);

-- ── Теперь арендатора проставляет сам запрос ────────────────────────────────
-- Без контекста (current_setting без второго аргумента) вставка падает - это
-- сознательный fail-closed: лучше ошибка, чем строка, уехавшая не тому арендатору.
ALTER TABLE booking_services ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE bookings ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE clients ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE discount_settings ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE holidays ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE kv_store ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE locations ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE master_payroll_settings ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE master_services ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE master_weekly_schedule ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE notifications ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE payroll_settings ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE sales ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE schedule_breaks ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE schedule_change_requests ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE schedule_shifts ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE services ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE sessions ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE staff ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;
ALTER TABLE staff_media ALTER COLUMN tenant_id SET DEFAULT current_setting('app.tenant_id')::int;

-- ── Ловушка 5: глобальные уникальные ключи становятся составными ────────────
-- Иначе почта сотрудника, телефон клиента или дата праздника у одного арендатора
-- физически запрещали бы такую же запись у другого.
-- Найдено живой репетицией 24.08.2026: одни и те же по смыслу ключи в этой схеме
-- заведены по-разному - staff_email_key как ограничение таблицы, clients_phone_key
-- как отдельный уникальный индекс. DROP CONSTRAINT на индекс молча ничего не делает,
-- и глобальный ключ остался бы жить рядом с новым составным. Поэтому снимаем обеими
-- формами: какая-то из двух сработает, вторая тихо пройдёт мимо.
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_email_key;
DROP INDEX IF EXISTS staff_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS staff_tenant_email_key ON staff (tenant_id, email);

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_phone_key;
DROP INDEX IF EXISTS clients_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS clients_tenant_phone_key ON clients (tenant_id, phone);

ALTER TABLE schedule_shifts DROP CONSTRAINT IF EXISTS schedule_shifts_master_id_date_key;
DROP INDEX IF EXISTS schedule_shifts_master_id_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS schedule_shifts_tenant_master_date_key ON schedule_shifts (tenant_id, master_id, date);

-- Один защищённый владелец - НА АРЕНДАТОРА, а не на всю систему: у Карины свой
DROP INDEX IF EXISTS staff_one_protected_owner_idx;
CREATE UNIQUE INDEX staff_one_protected_owner_idx ON staff (tenant_id) WHERE protected_owner = true;

-- Дедуп уведомлений считается внутри арендатора
DROP INDEX IF EXISTS notifications_booking_dedup;
CREATE UNIQUE INDEX notifications_booking_dedup ON notifications (tenant_id, staff_id, type, booking_id) WHERE booking_id IS NOT NULL;
DROP INDEX IF EXISTS notifications_schedreq_dedup;
CREATE UNIQUE INDEX notifications_schedreq_dedup ON notifications (tenant_id, staff_id, type, schedule_request_id) WHERE schedule_request_id IS NOT NULL;
DROP INDEX IF EXISTS notifications_master_dedup;
CREATE UNIQUE INDEX notifications_master_dedup ON notifications (tenant_id, staff_id, type, related_master_id) WHERE related_master_id IS NOT NULL;

-- Праздничный календарь свой у каждого арендатора (у клиники он другой)
ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_pkey;
ALTER TABLE holidays ADD PRIMARY KEY (tenant_id, date);

-- ── Ловушка 4: одиночные строки настроек - строка на арендатора ─────────────
-- payroll_settings.id (default 1) и discount_settings.id (boolean default true)
-- физически допускали ровно одну строку на всю систему. Теперь ровно одну на
-- арендатора: первичным ключом становится сам арендатор.
ALTER TABLE payroll_settings DROP CONSTRAINT IF EXISTS payroll_settings_pkey;
ALTER TABLE payroll_settings ADD PRIMARY KEY (tenant_id);
ALTER TABLE discount_settings DROP CONSTRAINT IF EXISTS discount_settings_pkey;
ALTER TABLE discount_settings ADD PRIMARY KEY (tenant_id);

-- kv_store - общий контракт /kv/:key, снятый Окном 33; таблица жива, ключ в ней
-- глобальный. Тот же ключ у второго арендатора не должен спотыкаться о чужую строку
ALTER TABLE kv_store DROP CONSTRAINT IF EXISTS kv_store_pkey;
ALTER TABLE kv_store ADD PRIMARY KEY (tenant_id, key);

-- ── Ловушка 6: арендатор первой колонкой в каждом индексе выборки ───────────
-- Замок из Фазы 3 добавляет условие по арендатору в каждый запрос. Если индекс
-- начинается не с него, база сначала прочитает чужие строки и только потом их
-- отбросит - на живом объёме это разница в два порядка.
DROP INDEX IF EXISTS bookings_master_date_idx;
CREATE INDEX bookings_master_date_idx ON bookings (tenant_id, master_id, date);
DROP INDEX IF EXISTS bookings_client_history_idx;
CREATE INDEX bookings_client_history_idx ON bookings (tenant_id, client_id, date, start_time);
-- Расписание и «Финансы» тянут записи за диапазон дат по всем мастерам сразу -
-- прежние два индекса такую выборку не покрывали ни до, ни после
CREATE INDEX IF NOT EXISTS bookings_tenant_date_idx ON bookings (tenant_id, date, start_time);

DROP INDEX IF EXISTS notifications_bell_idx;
CREATE INDEX notifications_bell_idx ON notifications (tenant_id, staff_id, created_at DESC) WHERE dismissed_at IS NULL;
DROP INDEX IF EXISTS notifications_staff_unread_idx;
CREATE INDEX notifications_staff_unread_idx ON notifications (tenant_id, staff_id, read_at, created_at DESC);

DROP INDEX IF EXISTS staff_media_staff_sort_idx;
CREATE INDEX staff_media_staff_sort_idx ON staff_media (tenant_id, staff_id, kind, sort_order, created_at);

DROP INDEX IF EXISTS schedule_change_requests_master_idx;
CREATE INDEX schedule_change_requests_master_idx ON schedule_change_requests (tenant_id, master_id, status);
DROP INDEX IF EXISTS schedule_change_requests_status_idx;
CREATE INDEX schedule_change_requests_status_idx ON schedule_change_requests (tenant_id, status, created_at);

DROP INDEX IF EXISTS staff_created_at_idx;
CREATE INDEX staff_created_at_idx ON staff (tenant_id, created_at, id);

-- Таблицы, которые читаются целиком «дай всё моё»: каталог услуг, точки, смены,
-- график, сессия по токену. Индекса по арендатору у них не было вовсе - раньше и
-- не требовалось, вся таблица и была ответом
CREATE INDEX IF NOT EXISTS services_tenant_sort_idx ON services (tenant_id, sort_order, id);
CREATE INDEX IF NOT EXISTS locations_tenant_idx ON locations (tenant_id, id);
CREATE INDEX IF NOT EXISTS sessions_tenant_idx ON sessions (tenant_id, token);
CREATE INDEX IF NOT EXISTS schedule_breaks_tenant_shift_idx ON schedule_breaks (tenant_id, shift_id);
CREATE INDEX IF NOT EXISTS master_services_tenant_idx ON master_services (tenant_id, master_id, service_id);
CREATE INDEX IF NOT EXISTS master_weekly_schedule_tenant_idx ON master_weekly_schedule (tenant_id, master_id, weekday);
CREATE INDEX IF NOT EXISTS master_payroll_settings_tenant_idx ON master_payroll_settings (tenant_id, master_id);
CREATE INDEX IF NOT EXISTS booking_services_tenant_idx ON booking_services (tenant_id, booking_id);
CREATE INDEX IF NOT EXISTS sales_tenant_booking_idx ON sales (tenant_id, booking_id);
