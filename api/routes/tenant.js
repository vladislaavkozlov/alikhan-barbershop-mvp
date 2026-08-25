// GET /tenant/appearance - словарь вертикали для кабинетов (Этап B, Фаза 1,
// 24.08.2026, plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// Роут открыт без входа осознанно: слова нужны экрану входа, то есть раньше, чем у
// человека появляется токен.
//
// Наружу уходят вертикаль, слова, флаги разделов и НАЗВАНИЕ заведения. Название
// добавлено 24.08.2026 по находке фазы 3: в готовых сообщениях клиенту зашито
// «это барбершоп «Алихан»», и словарём вертикали это не лечится - название своё у
// каждого арендатора. Секретом оно не является: этим именем заведение подписывается
// перед своими же клиентами. Ни доменов, ни телефонов, ни единого клиентского поля
// здесь по-прежнему нет.
//
// Арендатор уже определён гейтом домена в server.mjs, повторно его искать незачем:
// неизвестный домен до сюда не доходит, он получает 404 раньше.
import { sendJson } from '../lib/http.js';
import { appearanceFor } from '../lib/vertical-terms.js';
import { effectiveModules } from '../lib/vertical-modules.js';

export function handleTenantAppearance(req, res, tenant) {
  const appearance = appearanceFor(tenant?.vertical);
  return sendJson(res, 200, {
    ...appearance,
    name: typeof tenant?.name === 'string' ? tenant.name : '',
    modules: effectiveModules(appearance.vertical, tenant?.modules),
  });
}
