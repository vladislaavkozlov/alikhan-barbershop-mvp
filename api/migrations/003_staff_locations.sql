-- Правка Влада 28.07.2026: реальная привязка тестовых мастеров к точкам (в 002_schema.sql
-- location_id был NULL - на тот момент не было ни одного источника, откуда его взять,
-- придумывать не стали). Влад сам назвал разбивку: master-1/master-2 (Али, Мамед) →
-- Точка 1, master-3 (Елизавета) → Точка 2 - для демо реальным владельцем это рабочее
-- назначение, не факт о реальном штате (см. project_barbershop-crm-otkrytye-voprosy-relizu).
UPDATE staff SET location_id = 1 WHERE id IN ('master-1', 'master-2');
UPDATE staff SET location_id = 2 WHERE id = 'master-3';

-- Брони, уже созданные ДО этой миграции, унаследовали location_id = NULL от мастера
-- в момент записи (createBookingTx в server.mjs берёт location_id из staff на тот
-- момент) - без этого шага старые тестовые записи не попадут ни в Точку 1, ни в
-- Точку 2 задним числом, разбивка "Все точки" не будет совпадать с суммой по точкам.
UPDATE bookings SET location_id = 1 WHERE master_id IN ('master-1', 'master-2') AND location_id IS NULL;
UPDATE bookings SET location_id = 2 WHERE master_id = 'master-3' AND location_id IS NULL;
