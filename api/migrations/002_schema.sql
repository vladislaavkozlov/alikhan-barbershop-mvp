-- Окно 8 (27.07.2026): переход с временного kv_store (Окно 7, весь стор одним JSON-
-- блоком) на нормализованную схему. Источник сущностей и полей -
-- ~/Desktop/barbershop-crm-brief/ТЗ-для-разработчика.md разд.3 + разд.14.3 (находки
-- по 9 скриншотам реального ЛК YClients Алихана). kv_store не удаляется - остаётся
-- как есть, просто больше не используется для записей (bookings теперь отдельная
-- таблица), см. server.mjs.

CREATE TABLE locations (
  id serial primary key,
  name text not null,
  address text
);

CREATE TABLE staff (
  id text primary key,
  location_id integer references locations(id),
  name text not null,
  photo_url text,
  phone text,
  email text unique,
  role text not null check (role in ('owner','admin','master')),
  employed boolean not null default true,        -- в штате / уволен
  provides_services boolean not null default false, -- бронируется ли клиентами (разд.14.3 п.1)
  has_system_access boolean not null default true,  -- есть ли логин (разд.14.3 п.1)
  pin_hash text                                    -- простой логин email+PIN, формат "salt:hash" (scrypt)
);

CREATE TABLE services (
  id text primary key,
  name text not null,
  category text not null check (category in ('base','complex')), -- влияет на % зарплаты, разд.5
  duration_min integer not null,
  price integer not null,
  composition text
);

CREATE TABLE master_services (        -- компетенция + цена + длительность ПО МАСТЕРУ (разд.12 п.7,8)
  master_id text references staff(id),
  service_id text references services(id),
  price integer not null,
  duration_min integer not null,
  primary key (master_id, service_id)
);

CREATE TABLE clients (
  id text primary key,
  name text,
  phone text not null,                 -- скрыт от роли "мастер", разд.12 п.1
  birthday date,
  no_show_streak integer not null default 0,
  notes text
);
CREATE UNIQUE INDEX clients_phone_key ON clients (phone);

CREATE TABLE bookings (
  id text primary key,
  location_id integer references locations(id),
  master_id text references staff(id),
  service_id text references services(id),
  client_id text references clients(id),
  date date not null,
  start_time text not null,
  end_time text not null,
  status text not null check (status in ('planned','done','cancelled','no_show')), -- мэппинг разд.14.3 п.4
  client_confirmed boolean not null default false,  -- разд.14.3 п.4, отдельная ось от статуса
  channel text,
  created_at timestamptz not null default now()
);
CREATE INDEX bookings_master_date_idx ON bookings (master_id, date);

CREATE TABLE sales (                   -- новая сущность, разд.14.3 п.2 - без неё нечем считать % косметики (разд.5)
  id text primary key,
  booking_id text references bookings(id),
  item_name text not null,
  amount integer not null,
  created_at timestamptz not null default now()
);

CREATE TABLE schedule_shifts (
  id serial primary key,
  master_id text references staff(id),
  date date not null,
  start_time text not null,
  end_time text not null,
  unique (master_id, date)
);

CREATE TABLE schedule_breaks (         -- список интервалов, не одно поле - разд.14.1 (скриншот "Добавить перерыв")
  id serial primary key,
  shift_id integer references schedule_shifts(id) on delete cascade,
  start_time text not null,
  end_time text not null
);

CREATE TABLE payroll_settings (        -- редактируемые владельцем в Окне 9, не константы в коде
  id integer primary key default 1,
  base_rate_per_shift integer not null default 0,
  pct_base_service numeric not null default 0.45,
  pct_complex_service numeric not null default 0.5,
  pct_cosmetics numeric not null default 0,
  new_client_bonus integer not null default 0
);

-- Простая сессия под email+PIN логин (Шаг 3) - не JWT, не нужен для 2 точек и
-- десятка сотрудников. Токен непрозрачный, хранится в базе (не в памяти процесса -
-- Amvera-приложение может перезапускаться, in-memory сессии бы терялись).
CREATE TABLE sessions (
  token text primary key,
  staff_id text references staff(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ── Seed-данные ──────────────────────────────────────────────────────────
-- Точки: реальный адрес подтверждён владельцем (Ставрополь, ул. Андрея Голуба 16,
-- 2 точки, разный фасад - см. Бриф-для-оркестратора-ФИНАЛ-MVP.md). Названия точек -
-- рабочие ярлыки по вывескам с фото, не официальные названия (Алихан их не называл).
INSERT INTO locations (id, name, address) VALUES
  (1, 'Точка 1 (тёмный фасад)', 'Ставрополь, ул. Андрея Голуба 16'),
  (2, 'Точка 2 (светлый фасад, вывеска «Стрижем и бреем»)', 'Ставрополь, ул. Андрея Голуба 16');

-- Услуги: те же 8, что были хардкодом в storage.js (SERVICES) - цифры (цена/
-- длительность/состав) не меняются, просто переезжают в базу. Категория
-- base/complex - рабочая техническая классификация по длительности/составу (нужна
-- CHECK-констрейнтом схемы), НЕ подтверждена словами Алихана - точный % по категориям
-- всё ещё открытый вопрос (разд.11 п.1 ТЗ), редактируется в Окне 9 через payroll_settings.
INSERT INTO services (id, name, category, duration_min, price, composition) VALUES
  ('strizhka', 'Стрижка', 'base', 40, 2000, 'Консультация по подбору стрижки по форме лица и структуре волос, профессиональное выполнение, мытьё головы, одеколон/бальзам, расслабляющий массаж головы и шейно-воротниковой зоны, укладка проф. средствами'),
  ('boroda', 'Борода', 'base', 30, 1600, 'Консультация и подбор по форме лица, окантовка с бритвой, укладка проф. средствами, расслабляющий массаж головы и шейно-воротниковой зоны'),
  ('kompleks-strizhka-boroda', 'Комплекс стрижка+борода', 'complex', 60, 3500, 'Объединяет обе услуги выше'),
  ('britie', 'Бритьё', 'base', 40, 1500, 'Сухое бритьё электробритвой головы или бороды, мытьё головы или лица'),
  ('firmennaya-okantovka', 'Фирменная окантовка', 'base', 30, 1400, 'Стрижка под одну насадку или окантовка волос и бороды, мытьё головы'),
  ('tonirovka', 'Тонировка седых волос', 'complex', 60, 1500, 'Консультация и подбор цвета, мытьё зоны тонировки'),
  ('vosk', 'Воск', 'base', 15, 500, 'Удаление нежелательных волос горячим воском (уши, нос, лицо)'),
  ('spa-uhod', 'СПА уход', 'complex', 60, 3000, 'Профессиональная косметика, распаривание лица, скрабирование кожи, чёрная маска против чёрных точек, патчи, гидрогелевая маска, мытьё лица');

-- Мастера: те же 3 явно помеченных примерных мастера, что в storage.js (MASTERS,
-- isPlaceholder: true) - реальных сотрудников/логинов Алихан ещё не присылал.
-- location_id НЕ проставлен - реальной привязки мастер→точка нет ни в одном
-- источнике, придумывать не стал.
INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
  ('master-1', NULL, 'Иван 1 (пример)', 'master', true, true, true, 'master1-test@alikhan.test', 'e049281e287b8563496b3e0437614dbf:f41db3a9a52ae800c5b7ed742ddfd523de18842d46201cbd52fb7b09d45c28c5d6df39941449e876676f966d070918ac4e3bab9e2f2c8cf5fde425a71a7d9758'),
  ('master-2', NULL, 'Иван 2 (пример)', 'master', true, true, true, 'master2-test@alikhan.test', 'c7b66b98cd787ae16964754cc5c967a1:800e2727b10416626eed334674677ea96d1d89ec59830977fdb5ca58914045651227e9a183e2c5074e7dd0ae7ca1bfc8df6b2ea345e8635b0f639743ff97f1ea'),
  ('master-3', NULL, 'Иван 3 (пример)', 'master', true, true, true, 'master3-test@alikhan.test', '33abb9618dadfd986c15d65893e244be:7184d3969bf2cefcc752b7dd4893204a0a07e023d03e33da48e72a3e462f070ddb73111feaa3e408fec4fdd2856c309ff83a90d9ee1ce4f280dbbb852263fee3');

-- Тестовые логины owner/admin - реальных ФИО владелец не присылал, это учётки для
-- живой проверки ролей (см. промпт Окна 8, Шаг 5), не выдаются за реальных людей.
INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
  ('owner-test', NULL, 'Владелец (тест-логин)', 'owner', true, false, true, 'owner-test@alikhan.test', '6494ad219b94d913d62c3aed2293ced6:5c9aad0dc8d1ef358338619759c693a8d492d3ed660d829f4e864a8bb56a289f0edca54805fcc9cc1716c21084f6873e01a588db06b8a035aa89671725632540'),
  ('admin-loc1-test', 1, 'Администратор Точка 1 (тест-логин)', 'admin', true, false, true, 'admin1-test@alikhan.test', 'ff55c8de61d530ecca7c4b64149c6ae1:30e154650ead372364db55eeb43332c0f2cb0a5ce53751a277e278aff9c6de3424a3ef7b9287497cac093e605dd1d75e1f9a9f65335b1f29f8ac722c498d316d'),
  ('admin-loc2-test', 2, 'Администратор Точка 2 (тест-логин)', 'admin', true, false, true, 'admin2-test@alikhan.test', '0f4c81bd66a4c5faae5125bef56927e3:141942ec1ac2559a41dc813926afc81acb80725462db067c80fe53bc9ffbf709624a21f9b42e20e9290d2730ba1818f1619b53edc5061690fcf2ac6f82b472c7');

-- master_services: единый прайс/длительность на всех трёх мастеров (реальной
-- дифференциации "топ-мастер дороже" ещё нет - см. ТЗ разд.3). Данные = SERVICES.
INSERT INTO master_services (master_id, service_id, price, duration_min)
SELECT m.id, s.id, s.price, s.duration_min
FROM (VALUES ('master-1'), ('master-2'), ('master-3')) AS m(id)
CROSS JOIN services s;

INSERT INTO payroll_settings (id) VALUES (1);
