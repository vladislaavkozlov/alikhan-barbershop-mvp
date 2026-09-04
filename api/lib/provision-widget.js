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

// bookingUrl (04.09.2026) - полный адрес формы записи заведения. Его нельзя собрать
// из домена: сайты клиентов стоят на общем github.io, у каждого свой путь и свой ключ
// заведения в адресе. Нужен боту, чтобы не пришедший выбирал новое время сам, а не
// ждал звонка администратора
const ALLOWED_KEYS = ['domain', 'publicKey', 'origins', 'bookingUrl'];

// Две грабли Amvera, пойманные 01.09.2026 её же логами сборки:
//
// 1. Значение переменной в amvera.yml должно быть base64. JSON с двоеточиями ломает
//    разбор YAML: «": "» внутри строки читается как разделитель ключа и значения.
//    Amvera отвечает «Configuration error. Unknown configuration error» и МОЛЧА
//    перестаёт собирать проект - снаружи это выглядит как «пересборка не запускается»,
//    а работающий контейнер продолжает крутить старый код.
// 2. Коммит, который меняет только amvera.yml, пересборку не запускает. Разовые
//    операции выкатываются вместе хоть с одной строкой кода.
export async function provisionWidgetFromEnv(env = process.env) {
  // Только base64-переменная документирована как рабочая: JSON в amvera.yml ломает
  // разбор конфига (см. заметку ниже). Обычный TENANT_WIDGET принимаем для локальных
  // прогонов, где конфига Amvera нет вовсе
  const raw = env.TENANT_WIDGET_B64 ?? env.TENANT_WIDGET;
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

    // Адрес формы принимаем только по https и только на разрешённый сайт заведения:
    // ссылка уедет живому человеку в мессенджер, и подставить туда чужой адрес не
    // должно быть возможно даже случайной опечаткой в переменной
    let bookingUrl = null;
    if (spec.bookingUrl) {
      const parsed = new URL(String(spec.bookingUrl));
      if (parsed.protocol !== 'https:') throw new Error('bookingUrl должен быть https');
      if (!origins.includes(normalizeDomain(parsed.hostname))) {
        throw new Error(`bookingUrl ведёт на «${parsed.hostname}», которого нет в origins`);
      }
      bookingUrl = parsed.toString();
    }

    await runInTenant(tenant.id, () => pool.query(
      `UPDATE tenants SET public_key = $2, widget_origins = $3,
              booking_url = COALESCE($4, booking_url)
        WHERE id = $1`,
      [tenant.id, String(spec.publicKey), origins, bookingUrl],
    ));
    clearTenantCache();
    console.log(`TENANT_WIDGET: «${tenant.name}» получил ключ ${spec.publicKey} для сайтов: ${origins.join(', ')}${bookingUrl ? `, форма записи: ${bookingUrl}` : ''}`);
    return { tenantId: tenant.id, publicKey: spec.publicKey, origins, bookingUrl };
  } catch (err) {
    console.error('TENANT_WIDGET: ключ заведения не выдан -', err.message);
    return null;
  }
}
