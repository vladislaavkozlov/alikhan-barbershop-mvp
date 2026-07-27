-- Первая миграция Фазы 2: хранилище того же формата данных, что был в localStorage
-- (один JSON-блок по ключу), но теперь в реальной базе - чтобы проверить синхронизацию
-- между устройствами до того, как переходить на полную нормализованную схему
-- (locations/masters/services/bookings и т.д. из плана Фазы 2).
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
