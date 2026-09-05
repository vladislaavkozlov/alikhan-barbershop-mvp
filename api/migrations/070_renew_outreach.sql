-- 05.09.2026, решение Влада: «можно докрутить, чтобы клиент получал сообщение в тг,
-- а админ получал заявку на прозвон» - и следом «давай и остальные улучшим».
--
-- Что было. Из трёх причин потери на экране «Недополученная прибыль» разговор с
-- клиентом умела только одна - неявка (миграции 068-069): бот пишет не пришедшему
-- сам, человек жмёт кнопку, и звонит ему уже прогретый администратор. Две другие
-- причины продукт по-прежнему только показывал: сумма есть, имена есть, а дальше
-- владелец звонит вхолодную сам. Ровно та работа, ради снятия которой систему и
-- покупают.
--
-- Что делаем. Тот же разговор для клиента, который не возвращается в свой срок.
-- Отличие от неявки одно, но оно определяет всю схему: у неявки есть бронь-повод,
-- а у невозврата повода нет вовсе - есть только человек и его просроченный срок.
-- Поэтому сообщение живёт на клиенте, а не на брони, и дедуп ему нужен свой.
--
-- Два повода вместо одного (решение принято при проектировании, Владу озвучено):
--   renew_due     - срок наступил сегодня. Это профилактика: человек ещё не потерян,
--                   и стоит дешевле любого возврата. Деньги, которые не утекли,
--                   выгоднее денег, которые вернули;
--   renew_overdue - срок пропущен впервые (прошёл один полный цикл). Это уже
--                   реанимация, и текст у неё другой: не «пора», а «давно не были».
--
-- Чего здесь сознательно НЕТ: письма по разреженности («ходит реже, чем нужно»).
-- Сам продукт называет разреженность потенциалом, а не потерей (api/lib/renew.js,
-- SPARSE_RATIO): человек не обещал ходить чаще, он согласился на свой срок. Писать
-- ему «вы ходите реже, чем следует» - это претензия к клиенту за то, чего он не
-- обещал, и первый же такой текст стоит дороже, чем вся возвращённая сумма.
-- Разреженность остаётся списком для владельца, разговор по ней не ведётся.

-- ── Клиентские сообщения без брони ──────────────────────────────────────────
-- Ключ цикла: дата повода в 'YYYY-MM-DD'. Он и есть защита от повторов - у
-- сообщений по брони эту роль играет booking_id, здесь его нет. Уникальность
-- «арендатор + клиент + вид + дата повода» означает: одно «пора» на наступивший
-- срок и одно «давно не были» на первый пропущенный цикл, сколько бы раз ни
-- отработал сканер.
ALTER TABLE client_messages ADD COLUMN IF NOT EXISTS cycle_key text;

-- Индекс частичный и симметричен тому, что в 062 сделан для брони: там предикат
-- booking_id IS NOT NULL, здесь IS NULL. Две непересекающиеся половины одной
-- очереди, и ни одна не мешает другой.
CREATE UNIQUE INDEX IF NOT EXISTS client_messages_cycle_key
  ON client_messages (tenant_id, client_id, kind, cycle_key)
  WHERE booking_id IS NULL AND cycle_key IS NOT NULL;

-- Набор видов закрыт проверкой (062, пересобрана в 068) - пересобираем снова.
-- Имя constraint не хардкодим: тот же приём, что в 019/022/032/033/037/042/051/053.
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name FROM pg_constraint
  WHERE conrelid = 'client_messages'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%booking_confirm%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE client_messages DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE client_messages ADD CONSTRAINT client_messages_kind_check CHECK (kind IN (
  'booking_confirm', 'reminder_24h', 'reminder_2h', 'review_request', 'no_show_followup',
  'renew_due', 'renew_overdue'
));

-- ── Ответ клиента про возврат ───────────────────────────────────────────────
-- Ответ на письмо после неявки лежит на брони, потому что у него есть бронь-хозяин
-- (068: «у факта одна строка-владелец, и это сама неявка»). У ответа про возврат
-- хозяина-брони нет, и единственное место, где он осмыслен, - сам клиент.
--
-- Дата ответа хранится отдельно от факта по той же причине, что и в 068: список
-- владельца должен уметь показать «ответил вчера» и «молчит пятый день», а не
-- только «ответил».
ALTER TABLE clients ADD COLUMN IF NOT EXISTS renew_reply text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS renew_reply_at timestamptz;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_renew_reply_check;
ALTER TABLE clients ADD CONSTRAINT clients_renew_reply_check
  CHECK (renew_reply IS NULL OR renew_reply IN ('wants_time', 'not_now'));

-- Причина отказа - те же четыре варианта, что после неявки (069). Набор общий
-- намеренно: владельцу нужна одна сводка «почему люди не приходят», а не две
-- несводимые. Ответ необязателен, это вежливое «почему», а не опрос.
--
-- Имя колонки НЕ renew_reason, хотя по смыслу просилось именно оно: renew_reason
-- в clients занята с миграции 056 под другое - почему назначен такой СРОК
-- (recommended / hair / price / schedule / not_discussed, api/lib/renew-reason.js).
-- Совпадение имён здесь стоило бы дорого: проверка значений, навешенная на чужую
-- колонку, отвергла бы уже записанные ключи и сломала бы закрытие визита
ALTER TABLE clients ADD COLUMN IF NOT EXISTS renew_decline_reason text;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_renew_decline_reason_check;
ALTER TABLE clients ADD CONSTRAINT clients_renew_decline_reason_check
  CHECK (renew_decline_reason IS NULL OR renew_decline_reason IN ('price', 'time', 'other_place', 'changed_mind'));

-- Когда мы написали человеку в последний раз. Нужно ровно для одной вещи, но
-- важной: в списке «не вернулись» владелец должен отличать того, кому ещё никто
-- ничего не сказал, от того, кому написали и кто молчит. Первому пишет система,
-- второму звонит человек - это разные действия, и без этой даты они сливаются.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS renew_outreach_at timestamptz;

-- ── Заявка на прозвон в ленте ───────────────────────────────────────────────
-- Новый тип уведомления: «просит записать». От client_wants_move отличается тем,
-- что брони нет и переносить нечего - это новая запись человеку, который выпал из
-- цикла. Администратор в ленте должен видеть суть, не открывая карточку.
DO $$
DECLARE con_name text;
BEGIN
  SELECT conname INTO con_name FROM pg_constraint
  WHERE conrelid = 'notifications'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%booking_new%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type in (
  'booking_new', 'booking_moved_out', 'booking_moved_in', 'booking_cancelled',
  'client_wants_move', 'client_wants_cancel', 'client_will_be_late',
  'client_wants_return'
));

-- Уведомление про возврат не привязано к брони, поэтому уникальности по booking_id
-- ему не хватает: без своего ключа один и тот же человек, нажавший кнопку дважды,
-- дал бы администратору два одинаковых дела.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS client_id text REFERENCES clients (id) ON DELETE CASCADE;

-- Ключ - «пока заявка не разобрана, второй такой же не будет». Сутками ограничивать
-- нельзя технически: created_at::date зависит от таймзоны сессии, а Postgres требует
-- в индексном выражении IMMUTABLE-функцию, и на живой базе такая миграция падает
-- (поймано прогоном tools/verify-2026-09-05-renew-outreach.mjs до наката).
--
-- Условие read_at IS NULL даёт заодно и правильный смысл: администратор разобрал
-- заявку - человек снова может попросить записать его, и это будет новое дело, а не
-- дубль старого
CREATE UNIQUE INDEX IF NOT EXISTS notifications_client_return_key
  ON notifications (tenant_id, staff_id, type, client_id)
  WHERE client_id IS NOT NULL AND read_at IS NULL;
