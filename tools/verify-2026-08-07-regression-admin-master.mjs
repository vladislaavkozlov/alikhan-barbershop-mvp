// Быстрая регрессия: crm-admin.html/crm-master.html не трогались этой сессией, но
// делят mockup-crm.css (правка .notif-bell svg) - проверяем, что страницы грузятся
// без консольных ошибок и колокольчик не сломался.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withEphemeralServer(async ({ apiUrl, db }) => {
  const pinAdmin = randomPin();
  const pinMaster = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ('smoke-admin', NULL, 'QA Админ', 'admin', true, false, true, 'smoke-admin@test.local', $1)`,
    [hashPin(pinAdmin)]
  );
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ('smoke-master', NULL, 'QA Мастер', 'master', true, true, true, 'smoke-master@test.local', $1)`,
    [hashPin(pinMaster)]
  );

  await withStaticServer(apiUrl, async (base) => {
    await withBrowser(async (s) => {
      const errors = [];
      s.onConsoleError?.((msg) => errors.push(msg));

      await s.navigate(`${base}/crm-admin.html`);
      await s.setViewport(1440, 1000, true);
      await sleep(400);
      await s.type('#loginEmail', 'smoke-admin@test.local');
      await s.type('#loginPin', pinAdmin);
      await s.click('#loginForm button[type="submit"]');
      await sleep(1000);
      const adminOk = await s.eval(`!document.getElementById('crmMain').hidden`);
      check('crm-admin.html логин проходит, страница открылась', adminOk);
      await s.screenshot('/tmp/regression-admin.png');

      await s.navigate(`${base}/crm-master.html`);
      await sleep(400);
      await s.type('#loginEmail', 'smoke-master@test.local');
      await s.type('#loginPin', pinMaster);
      await s.click('#loginForm button[type="submit"]');
      await sleep(1000);
      const masterOk = await s.eval(`!document.getElementById('crmMain').hidden`);
      check('crm-master.html логин проходит, страница открылась', masterOk);
      await s.screenshot('/tmp/regression-master.png');

      check('Без новых консольных ошибок на admin/master', errors.length === 0, errors.join(' | '));
    });
  });
});

summary();
