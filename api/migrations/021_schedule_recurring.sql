-- Правка Влада 03.08.2026: перерыв/выходной раньше существовал только как запись
-- на КОНКРЕТНУЮ дату (schedule_shifts/schedule_breaks) - "стандартного" перерыва,
-- который сам действует на каждый будущий рабочий день, в базе не было вообще.
-- Теперь 4 категории вместо 2: разовый отгул/отпуск (механика та же, что раньше -
-- только новый ярлык category для истории владельца) и НОВОЕ - стандартный перерыв/
-- выходной (schedule_recurring_rules, по дням недели, без конечной даты).
--
-- category - ярлык ЧТО выбрал мастер, request_type - ЧТО это МЕХАНИЧЕСКИ (break =
-- блок часов, day_off = весь день). Разовые (otgul/otpusk) продолжают жить в
-- date_from/date_to как раньше. Стандартные (pereryv_standard/vyhodnoy_standard)
-- используют новые weekdays/date_to остаётся NULL (бессрочно).
ALTER TABLE schedule_change_requests
  ADD COLUMN category text NOT NULL DEFAULT 'otgul'
    CHECK (category IN ('otgul', 'otpusk', 'pereryv_standard', 'vyhodnoy_standard')),
  ADD COLUMN weekdays smallint[]; -- только для pereryv_standard/vyhodnoy_standard: 1=Пн..7=Вс

ALTER TABLE schedule_change_requests ALTER COLUMN date_to DROP NOT NULL;
-- date_to = NULL означает "бессрочно" - имеет смысл только вместе со standard-категориями,
-- для otgul/otpusk дата "по" остаётся обязательной на уровне API (проверка в server.mjs).

-- Действующие правила "стандартного" графика. Разрешена только ОДНА активная запись
-- на пару (мастер, тип) - если владелец меняет стандартный перерыв, старое правило
-- деактивируется (active=false), а не удаляется - история остаётся видна.
CREATE TABLE schedule_recurring_rules (
  id serial primary key,
  master_id text not null references staff(id),
  rule_type text not null check (rule_type in ('break', 'day_off')),
  weekdays smallint[] not null, -- 1=Пн..7=Вс, минимум один день
  start_time text, -- null для day_off (весь день), обязателен для break
  end_time text,   -- null для day_off, обязателен для break
  starts_on date not null default current_date,
  active boolean not null default true,
  source_request_id integer references schedule_change_requests(id),
  created_at timestamptz not null default now()
);
CREATE INDEX schedule_recurring_rules_master_idx ON schedule_recurring_rules (master_id, active);
