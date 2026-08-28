// Уведомления на телефон: обвязка (Окно 73, 28.08.2026).
//
// Проверяется не криптография (для неё api.webpush.test.js), а то, как отправка
// вплетена в систему: где вызывается, что не роняет, кто имеет право подписаться.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

test('телефон звонит там же, где появляется запись в колокольчике', async () => {
  const notify = await source('api/lib/notify-core.js');
  assert.match(notify, /import \{ deliverPushLater \}/, 'ядро уведомлений не знает про телефон');
  // Обе ветки notifyStaff - и обычная вставка, и обновление при переносе записи
  // Две ветки notifyStaff: обычная вставка и обновление при переносе записи
  assert.equal((notify.match(/deliverPushLater\(/g) ?? []).length, 2, 'звонить должны обе ветки уведомления');
});

test('дубль в колокольчике не звонит на телефон второй раз', async () => {
  const notify = await source('api/lib/notify-core.js');
  // ON CONFLICT DO NOTHING молча не вставляет строку при повторе. Без RETURNING и
  // проверки rowCount телефон звонил бы на событие, которого в ленте не появилось
  assert.match(notify, /ON CONFLICT DO NOTHING\s*\n\s*RETURNING id/);
  assert.match(notify, /if \(inserted\.rowCount > 0\) deliverPushLater/);
});

test('фоновая отправка открывает свой контекст арендатора, а не берёт чужое соединение', async () => {
  const delivery = await source('api/lib/push-delivery.js');
  // Соединение принадлежит запросу и отпускается вместе с ним. К моменту
  // setImmediate исходный запрос уже ответил браузеру - работа по `pool` оттуда
  // означала бы обращение по чужому соединению
  assert.match(delivery, /currentTenantId\(\)/, 'арендатор не запоминается до ухода в фон');
  assert.match(delivery, /runInTenant\(tenantId,/, 'фон не открывает свой контекст');
  // Ищем именно вызов, а не слово: оно встречается ещё и в пояснении выше по файлу
  const order = delivery.indexOf('tenantId = currentTenantId()') < delivery.indexOf('setImmediate(()');
  assert.ok(order, 'арендатор берётся уже после ухода в фон - там контекста нет');
});

test('недоступность сервиса доставки не роняет то, ради чего звали', async () => {
  const delivery = await source('api/lib/push-delivery.js');
  assert.match(delivery, /\.catch\(/, 'ошибка отправки ничем не перехвачена');
  assert.match(delivery, /try \{[\s\S]*?await sendPush[\s\S]*?\} catch/, 'сбой одного устройства обрывает рассылку остальным');
});

test('мёртвая подписка выбрасывается, а не копится вечно', async () => {
  const webpush = await source('api/lib/webpush.js');
  const delivery = await source('api/lib/push-delivery.js');
  assert.match(webpush, /gone: res\.status === 404 \|\| res\.status === 410/);
  assert.match(delivery, /if \(res\.gone\)[\s\S]*?DELETE FROM push_subscriptions/);
});

test('без настроенных ключей система молчит, а не падает', async () => {
  const delivery = await source('api/lib/push-delivery.js');
  assert.match(delivery, /export const pushConfigured = \(\) => Boolean\(PUBLIC_KEY && PRIVATE_KEY\)/);
  assert.match(delivery, /if \(!pushConfigured\(\) \|\| !staffId\) return;/);
});

test('подписаться может только вошедший, и только на своё устройство', async () => {
  const server = await source('api/server.mjs');
  for (const path of ['push/key', 'push/status', 'push/subscribe', 'push/unsubscribe']) {
    assert.match(server, new RegExp(`path: '${path}', auth: 'any-staff'`), `${path}: уровень доступа не тот`);
  }
  const push = await source('api/routes/push.js');
  // Отписка сверяет владельца: чужое устройство отключить нельзя
  assert.match(push, /DELETE FROM push_subscriptions WHERE endpoint = \$1 AND staff_id = \$2/);
  // Адрес доставки принимается только https - иначе в таблицу уедет что угодно
  assert.match(push, /\/\^https:/, 'адрес доставки принимается без проверки на https');
});

test('фоновый обработчик не кэширует страницы - это чужая частая беда', async () => {
  const sw = await source('sw.js');
  assert.doesNotMatch(sw, /caches\.(open|match)/, 'обработчик начал кэшировать - будет «у меня старая версия»');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  assert.match(sw, /skipWaiting\(\)/, 'новая версия обработчика не вступит в силу сразу');
});

test('на айфоне вместо неработающего тумблера показывается инструкция', async () => {
  const push = await source('assets/crm-push.js');
  assert.match(push, /ios-needs-install/);
  assert.match(push, /isStandalone\(\)/, 'не проверяется, запущен ли кабинет с экрана Домой');
  assert.match(push, /P\('push\.iosInstall'\)/, 'текст инструкции написан руками мимо словаря вертикали');
});
