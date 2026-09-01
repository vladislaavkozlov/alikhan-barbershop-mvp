-- Сообщения клиенту: движок очереди и привязка к мессенджеру
-- (01.09.2026, plans/2026-09-01-volna-1-bot-max.md, Волна 1).
--
-- Почему четыре таблицы, а не одна колонка в bookings. Отправка клиенту это не
-- признак брони, а самостоятельное событие со своим временем, своей судьбой и
-- своей историей ошибок: одна бронь порождает четыре сообщения в разные моменты,
-- любое из них может не доехать и быть отправлено повторно. Колонкой в bookings
-- это не описывается, а попытка описать даёт ровно ту кашу, из-за которой
-- review_request_pending с 06.08.2026 висит проставленным и никуда не ведёт.
--
-- Канал отделён от движка намеренно. Алихан ждёт МАКС, Карина - Telegram, кто-то
-- третий останется на SMS. Очередь про «что и когда сказать», транспорт про «как
-- доставить»: смена мессенджера не должна переписывать логику напоминаний.

-- ── Бот арендатора ──────────────────────────────────────────────────────────
-- У каждого заведения свой бот со своим токеном: клиенты клиники не должны
-- получать сообщения от бота барбершопа, и в МАКС ник бота вообще привязан к ИНН
-- владельца. Токен лежит в базе, а не в переменных окружения, потому что
-- подключение очередного арендатора не должно требовать пересборки сервера.
--
-- Замка арендатора здесь нет по той же причине, что у tenants: строка читается
-- ДО того, как арендатор известен - входящий запрос от Telegram приходит на
-- секретный адрес, и именно по нему мы понимаем, чей это бот.
CREATE TABLE IF NOT EXISTS tenant_channels (
  tenant_id int NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('telegram', 'max', 'sms')),
  bot_token text,
  bot_username text,
  -- Секрет в адресе webhook. По нему входящее обновление сопоставляется с
  -- арендатором и одновременно отсекается посторонний, знающий только домен
  webhook_secret text,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_channels_secret_key
  ON tenant_channels (webhook_secret) WHERE webhook_secret IS NOT NULL;

-- ── Привязка клиента к мессенджеру ──────────────────────────────────────────
-- Ни бот Telegram, ни бот МАКС не могут написать человеку первым: адрес диалога
-- появляется только после того, как человек сам открыл бота. Эта таблица и есть
-- ответ на вопрос «кому мы вообще имеем право написать».
CREATE TABLE IF NOT EXISTS client_channels (
  id text PRIMARY KEY,
  tenant_id int NOT NULL DEFAULT current_setting('app.tenant_id')::int REFERENCES tenants (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('telegram', 'max')),
  -- chat_id диалога с ботом. Текстом, а не числом: у разных платформ разный тип
  external_id text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  -- Человек нажал «отписаться» или заблокировал бота. Строку не удаляем: иначе
  -- на следующей брони мы бодро пригласим его снова и получим жалобу
  unsubscribed_at timestamptz,
  last_error text
);
-- Один клиент - один диалог в канале
CREATE UNIQUE INDEX IF NOT EXISTS client_channels_client_key
  ON client_channels (tenant_id, client_id, channel);
-- И обратно: один диалог принадлежит одному клиенту. Если человек пришёл по
-- ссылке второй раз с другого номера, привязку надо переносить, а не двоить
CREATE UNIQUE INDEX IF NOT EXISTS client_channels_external_key
  ON client_channels (tenant_id, channel, external_id);

ALTER TABLE client_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_channels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON client_channels;
CREATE POLICY tenant_isolation ON client_channels
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

-- ── Одноразовое приглашение в бота ──────────────────────────────────────────
-- Токен уезжает в ссылку вида t.me/<бот>?start=<токен>. В ссылке не может быть
-- ни телефона, ни id клиента: её пересылают, ей делятся, она попадает в чужие
-- руки. Одноразовый токен с коротким сроком жизни - единственное, что не жалко
-- потерять: подобравший чужую ссылку получит чужие напоминания, поэтому срок
-- жизни короткий, а использование одно.
CREATE TABLE IF NOT EXISTS client_channel_invites (
  token text PRIMARY KEY,
  tenant_id int NOT NULL DEFAULT current_setting('app.tenant_id')::int REFERENCES tenants (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('telegram', 'max')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS client_channel_invites_client_idx
  ON client_channel_invites (tenant_id, client_id, channel);

ALTER TABLE client_channel_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_channel_invites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON client_channel_invites;
CREATE POLICY tenant_isolation ON client_channel_invites
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());

-- ── Очередь сообщений клиенту ───────────────────────────────────────────────
-- Строка ставится в очередь в момент события (запись создана, визит закрыт), а
-- уходит в свой срок. Отдельная строка на каждое сообщение нужна ради переносов
-- и отмен: перенесли бронь - старые напоминания отменяются, ставятся новые.
CREATE TABLE IF NOT EXISTS client_messages (
  id text PRIMARY KEY,
  tenant_id int NOT NULL DEFAULT current_setting('app.tenant_id')::int REFERENCES tenants (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  booking_id text REFERENCES bookings (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'booking_confirm', 'reminder_24h', 'reminder_2h', 'review_request'
  )),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'skipped')),
  -- Каким каналом ушло. Заполняется при отправке, а не при постановке: пока
  -- сообщение ждёт своего часа, клиент может успеть привязать бота
  channel text,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Одна бронь - одно сообщение каждого вида. Защита от двойной постановки при
-- повторном сохранении брони и от гонки двух тиков планировщика
CREATE UNIQUE INDEX IF NOT EXISTS client_messages_booking_kind_key
  ON client_messages (tenant_id, booking_id, kind) WHERE booking_id IS NOT NULL;
-- Основной запрос планировщика: «что пора отправлять»
CREATE INDEX IF NOT EXISTS client_messages_due_idx
  ON client_messages (status, due_at) WHERE status = 'pending';

ALTER TABLE client_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON client_messages;
CREATE POLICY tenant_isolation ON client_messages
  FOR ALL
  USING (app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (app_current_tenant() IS NULL OR tenant_id = app_current_tenant());
