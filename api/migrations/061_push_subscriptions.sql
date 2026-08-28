-- Подписки устройств на уведомления (Окно 73, 28.08.2026).
--
-- Одна строка - одно устройство одного сотрудника: у Али телефон и планшет на
-- стойке, это две подписки. Адрес доставки (endpoint) уникален глобально, его
-- выдаёт сервис Google или Apple, поэтому по нему и защищаемся от дублей при
-- повторной подписке того же браузера.
--
-- Ключи здесь не наши, а устройства: ими шифруется содержимое так, чтобы
-- прочитать его мог только этот браузер. Секретом сервера они не являются, но
-- вместе с адресом позволяют слать уведомления - поэтому таблица под тем же
-- замком арендатора, что и остальные.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id text PRIMARY KEY,
  tenant_id int NOT NULL DEFAULT current_setting('app.tenant_id')::int REFERENCES tenants (id) ON DELETE CASCADE,
  staff_id text NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count int NOT NULL DEFAULT 0
);

-- Повторная подписка того же браузера обновляет строку, а не плодит новые
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key ON push_subscriptions (endpoint);
-- Основной запрос отправки: «все устройства этого сотрудника»
CREATE INDEX IF NOT EXISTS push_subscriptions_staff_idx ON push_subscriptions (tenant_id, staff_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON push_subscriptions;
CREATE POLICY tenant_isolation ON push_subscriptions
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());
