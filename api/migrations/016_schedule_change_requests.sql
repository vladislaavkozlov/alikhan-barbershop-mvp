-- Окно 14 (02.08.2026, Задача 3) - согласование графика: мастер запрашивает
-- перерыв/выходной с комментарием, владелец (только owner, не admin - см.
-- ограничения промпта) одобряет/отклоняет, время реально блокируется от онлайн-записи
-- только при одобрении (см. правку createBookingTx в server.mjs той же сессии).
CREATE TABLE schedule_change_requests (
  id serial primary key,
  master_id text not null references staff(id),
  request_type text not null check (request_type in ('break','day_off')),
  date_from date not null,
  date_to date not null,
  start_time text,
  end_time text,
  master_comment text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  owner_comment text,
  decided_by text references staff(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
CREATE INDEX schedule_change_requests_master_idx ON schedule_change_requests (master_id, status);
CREATE INDEX schedule_change_requests_status_idx ON schedule_change_requests (status, created_at);
