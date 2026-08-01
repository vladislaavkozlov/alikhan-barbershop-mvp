-- Окно 10 (30.07.2026): реальный прайс по мастеру - ответ Алихана, разд.17.2 ТЗ
-- (~/Desktop/barbershop-crm-brief/ТЗ-для-разработчика.md). master_services уже
-- поддерживал цену по мастеру с самого Окна 8 (002_schema.sql) - там просто был
-- одинаковый прайс на всех троих (наследие MVP). Али/Мамедхан (master-1/master-2)
-- совпадают с текущей ценой services - трогать нечего. Меняется только Елизавета
-- (master-3, ранее переименованный из плейсхолдера в Окне 10) - у неё отдельный, более низкий прайс.
-- "СПА уход" в ответе Алихана не упомянут вообще - цену не выдумываем, оставляем
-- как есть (3000, совпадает с остальными).
UPDATE master_services SET price = 1500 WHERE master_id = 'master-3' AND service_id = 'strizhka';
UPDATE master_services SET price = 1200 WHERE master_id = 'master-3' AND service_id = 'boroda';
UPDATE master_services SET price = 2500 WHERE master_id = 'master-3' AND service_id = 'kompleks-strizhka-boroda';
UPDATE master_services SET price = 1000 WHERE master_id = 'master-3' AND service_id = 'firmennaya-okantovka';
UPDATE master_services SET price = 1000 WHERE master_id = 'master-3' AND service_id = 'britie';
UPDATE master_services SET price = 1200 WHERE master_id = 'master-3' AND service_id = 'tonirovka';
-- vosk (500) и spa-uhod (3000) у Елизаветы совпадают с Али/Мамедхан - не трогаем.
