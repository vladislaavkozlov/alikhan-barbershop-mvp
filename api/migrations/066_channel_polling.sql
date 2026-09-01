-- Способ доставки обновлений от бота (01.09.2026, найдено на боевом сервере).
--
-- Webhook на Amvera не работает. Диагноз снят с самого Telegram
-- (getWebhookInfo): адрес установлен верно, но «Connection timed out» - их
-- серверы до нашего хостинга не доходят. Проверено встречно: тот же адрес с
-- нашей машины отвечает за 0.2 секунды, а исходящие запросы с сервера к
-- api.telegram.org проходят - webhook ведь как-то установился.
--
-- Остаётся опрос: сервер сам спрашивает обновления. Для Telegram это штатный
-- production-режим (в отличие от МАКС, где документация прямо велит опрос в
-- проде не использовать - там придётся решать иначе).
--
-- Смещение хранится в базе, а не в памяти процесса: перезапуск контейнера не
-- должен приводить ни к потере ответа клиента, ни к повторной обработке уже
-- обработанного нажатия.
ALTER TABLE tenant_channels
  ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'polling'
    CHECK (delivery IN ('webhook', 'polling'));

ALTER TABLE tenant_channels
  ADD COLUMN IF NOT EXISTS poll_offset bigint NOT NULL DEFAULT 0;
