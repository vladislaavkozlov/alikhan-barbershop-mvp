-- Окно 14 (02.08.2026, Задача 5) - уведомления в личном кабинете (мастера и
-- владельца), поллинг внутри уже открытой страницы, НЕ системный push (см.
-- ограничения промпта - Notification API браузера не нужен).
CREATE TABLE notifications (
  id text primary key,
  staff_id text not null references staff(id) on delete cascade,
  type text not null check (type in (
    'booking_new', 'booking_reminder_15', 'booking_start',
    'schedule_request_new', 'schedule_request_decided'
  )),
  booking_id text references bookings(id) on delete cascade,
  schedule_request_id integer,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
CREATE INDEX notifications_staff_unread_idx ON notifications (staff_id, read_at, created_at desc);
CREATE UNIQUE INDEX notifications_booking_dedup ON notifications (staff_id, type, booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX notifications_schedreq_dedup ON notifications (staff_id, type, schedule_request_id) WHERE schedule_request_id IS NOT NULL;
