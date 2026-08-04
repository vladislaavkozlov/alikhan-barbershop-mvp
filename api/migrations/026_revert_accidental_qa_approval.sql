-- Окно 17 (04.08.2026) - откат случайной правки. При живой проверке happy-path
-- (Задача 0, "конфликт снят - одобрение проходит") QA-сессия повторно вызвала
-- PATCH /schedule-requests/4/decision после отмены тестовой брони - заявка
-- id=4 (grafik_standard, тестовые данные PM-сессии 03.08, ДОЛЖНА была остаться
-- pending как песочница - см. промпт Окна 17, задача 4) вместо этого реально
-- применилась к недельному графику Елизаветы (master-3): 7 рабочих дней без
-- выходного. До этой правки master_weekly_schedule для master-3 была пустой
-- (проверено curl'ом непосредственно перед инцидентом) - откатываем ровно к
-- этому состоянию и возвращаем заявку в pending, как будто одобрения не было.
DELETE FROM master_weekly_schedule WHERE master_id = 'master-3';
UPDATE schedule_change_requests
  SET status = 'pending', owner_comment = NULL, decided_by = NULL, decided_at = NULL
  WHERE id = 4;
