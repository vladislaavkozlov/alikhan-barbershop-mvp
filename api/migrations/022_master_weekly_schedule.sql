-- Окно 16 (03.08.2026) - единый блок "График работы". Разд.28 промпта: старая
-- schedule_recurring_rules (миграция 021) хранила ОДНО правило (перерыв ИЛИ выходной)
-- на массив дней недели с ОДНИМ временем на все выбранные дни - не позволяла задать
-- разные рабочие часы/перерыв на каждый день недели по отдельности (нужно для
-- UI-паттерна Google Calendar "Working hours", одобрен Владом). В проде на момент
-- этой миграции 0 строк (проверено curl .../schedule-recurring, 03.08.2026 вечером) -
-- меняем схему свободно, миграции данных нет. Новая модель - ОДНА строка на пару
-- (мастер, день недели), полностью описывающая день: работает/нет, часы, перерыв.
-- Отсутствие строки для (мастер, день) = глобальный дефолт 10:00-20:00, без перерыва
-- (тот же фолбэк, что уже был раньше, см. getEffectiveSchedule в server.mjs).
CREATE TABLE master_weekly_schedule (
  master_id text NOT NULL REFERENCES staff(id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1=Пн..7=Вс
  is_working boolean NOT NULL DEFAULT true,
  work_start text,
  work_end text,
  break_start text,
  break_end text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (master_id, weekday),
  CHECK (NOT is_working OR (work_start IS NOT NULL AND work_end IS NOT NULL)),
  CHECK ((break_start IS NULL) = (break_end IS NULL))
);

DROP TABLE schedule_recurring_rules;

-- Мастер запрашивает изменение ПОСТОЯННОГО графика (весь набор дней недели за раз,
-- владелец одобряет/отклоняет целиком) - та же таблица заявок schedule_change_requests
-- (миграция 016/021), новая категория grafik_standard вместо снятых
-- pereryv_standard/vyhodnoy_standard. otgul/otpusk не трогаем (разд.31 промпта -
-- механика одноразового отгула/отпуска остаётся как есть).
ALTER TABLE schedule_change_requests ADD COLUMN weekly_changes jsonb;

DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'schedule_change_requests'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE schedule_change_requests DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
ALTER TABLE schedule_change_requests ADD CONSTRAINT schedule_change_requests_category_check
  CHECK (category IN ('otgul', 'otpusk', 'grafik_standard'));

DO $$
DECLARE con record;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'schedule_change_requests'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%request_type%'
  LOOP
    EXECUTE format('ALTER TABLE schedule_change_requests DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
ALTER TABLE schedule_change_requests ADD CONSTRAINT schedule_change_requests_request_type_check
  CHECK (request_type IN ('break', 'day_off', 'weekly_schedule'));
