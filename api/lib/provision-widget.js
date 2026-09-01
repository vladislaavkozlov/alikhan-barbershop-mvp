// Ключ заведения и список его сайтов из переменной окружения (01.09.2026).
//
// Тот же механизм, что у provision-tenant и provision-channel, и по той же
// причине: база живёт во внутренней сети, а роут «выдайте ключ заведению» - это
// дверь, за которой чужой сайт получает доступ к каталогу и записи. Переменная
// плюс перезапуск.
//
// Секретов здесь нет: ключ заведения публичный по назначению, он ездит в адресе
// запроса с сайта клиента. Защищает не он сам, а список источников рядом с ним.
import { registryQuery, pool, runInTenant } from './db.js';
import { normalizeDomain, clearTenantCache } from './tenants.js';

const ALLOWED_KEYS = ['domain', 'publicKey', 'origins'];

export async function provisionWidgetFromEnv(env = process.env) {
  const raw = env.TENANT_WIDGET;
  if (!raw) return null;
  try {
    let text = String(raw).trim();
    if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8');
    const spec = JSON.parse(text);
    for (const key of Object.keys(spec)) {
      if (!ALLOWED_KEYS.includes(key)) throw new Error(`незнакомый ключ «${key}». Ожидались: ${ALLOWED_KEYS.join(', ')}`);
    }
    if (!spec.domain) throw new Error('нужен domain заведения');
    if (!spec.publicKey) throw new Error('нужен publicKey');
    if (!Array.isArray(spec.origins) || spec.origins.length === 0) {
      throw new Error('нужен непустой origins: ключ без списка сайтов работал бы с любого адреса');
    }
    const origins = spec.origins.map((o) => normalizeDomain(o)).filter(Boolean);

    const found = await registryQuery(
      `SELECT id, name FROM tenants WHERE $1 = ANY(domains) AND status = 'active'`,
      [normalizeDomain(spec.domain)],
    );
    const tenant = found.rows[0];
    if (!tenant) throw new Error(`заведение с доменом «${spec.domain}» не найдено`);

    await runInTenant(tenant.id, () => pool.query(
      `UPDATE tenants SET public_key = $2, widget_origins = $3 WHERE id = $1`,
      [tenant.id, String(spec.publicKey), origins],
    ));
    clearTenantCache();
    console.log(`TENANT_WIDGET: «${tenant.name}» получил ключ ${spec.publicKey} для сайтов: ${origins.join(', ')}`);
    return { tenantId: tenant.id, publicKey: spec.publicKey, origins };
  } catch (err) {
    console.error('TENANT_WIDGET: ключ заведения не выдан -', err.message);
    return null;
  }
}
