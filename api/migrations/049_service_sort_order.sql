-- Единый порядок показа услуг во всех формах выбора (Влад, 16.08.2026).
-- До этого /services сортировался по имени, а /master-services - по service_id:
-- клиент на сайте, владелец, админ и мастер видели три разных алфавитных порядка,
-- ни один из которых не совпадал с тем, как барбершоп продаёт услуги.
-- Порядок: стрижка → борода → комплекс → бритьё → фирменная окантовка →
-- тонировка → воск → СПА уход. Тот же порядок объявлен в storage.js (SERVICES).
ALTER TABLE services ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 999;

-- Услуга, заведённая позже и не попавшая в этот список, остаётся с 999 и уходит
-- в хвост - показ не ломается, порядок внутри хвоста доопределяется по имени.
UPDATE services SET sort_order = v.ord
FROM (VALUES
  ('strizhka', 1),
  ('boroda', 2),
  ('kompleks-strizhka-boroda', 3),
  ('britie', 4),
  ('firmennaya-okantovka', 5),
  ('tonirovka', 6),
  ('vosk', 7),
  ('spa-uhod', 8)
) AS v(id, ord)
WHERE services.id = v.id AND services.sort_order IS DISTINCT FROM v.ord;
