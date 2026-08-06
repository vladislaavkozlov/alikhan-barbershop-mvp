// Живая проверка Окна 35 - владелец не теряет мастера молча (FINAL_PRODUCT_DECISION.md
// MUST HAVE Epic 3). Реальный инцидент: Мамедхан (master-2) был невидим для записи
// несколько дней, никто не узнал, пока не проверили curl'ом вручную
// (PROJECT_UNDERSTANDING.md разд.7). Эта проверка воспроизводит ровно тот случай -
// master-1 и master-3 бронируемы, master-2 - нет.
//
// Своя эфемерная база/сервер (tools/verify-lib.mjs), свой fixture-владелец (тот же
// приём, что tests/api.roles.test.js FIXTURE_MASTER_LOC1/LOC2) - реальные PIN
// боевых сотрудников (Окно 33) в репозитории не хранятся, и не должны.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const ownerPin = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ('verify-owner-o35', NULL, 'QA Владелец Окно35', 'owner', true, false, true, 'verify-owner-o35@test.local', $1)`,
    [hashPin(ownerPin)]
  );
  // master-1 и master-3 бронируемы (полный график каждый день) - master-2 (Мамедхан)
  // намеренно остаётся БЕЗ единой is_working=true строки, ровно как в реальном
  // инциденте, который и породил это окно.
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT m, d, true, '10:00', '20:00' FROM unnest(ARRAY['master-1','master-3']) m, generate_series(1,7) d`
  );

  // ── Слой 1: контракт бэкенда напрямую (без браузера) ──────────────────────
  const loginRes = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'verify-owner-o35@test.local', pin: ownerPin }),
  });
  check('первый вход владельца - 200 OK', loginRes.status === 200);
  const { token } = await loginRes.json();

  const ntfRes1 = await fetch(`${apiUrl}/notifications`, { headers: { Authorization: `Bearer ${token}` } });
  const ntfList1 = await ntfRes1.json();
  const lostSchedule1 = ntfList1.filter((n) => n.type === 'master_lost_schedule');
  check('после первого входа - ровно одно уведомление master_lost_schedule', lostSchedule1.length === 1);
  check('уведомление ссылается на master-2 (Мамедхан)', lostSchedule1[0]?.relatedMasterId === 'master-2');
  check('title содержит имя мастера', typeof lostSchedule1[0]?.title === 'string' && lostSchedule1[0].title.includes('Мамедхан'));

  const dbCountAfter1 = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE type = 'master_lost_schedule'`);
  check('в БД ровно одна строка master_lost_schedule (не задвоилась внутри одного запроса)', dbCountAfter1.rows[0].n === 1);

  // Повторный вход тем же владельцем - не должно задвоиться.
  const loginRes2 = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'verify-owner-o35@test.local', pin: ownerPin }),
  });
  check('повторный вход владельца - 200 OK', loginRes2.status === 200);
  const dbCountAfter2 = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE type = 'master_lost_schedule'`);
  check('повторный вход НЕ создал второе уведомление (дедуп)', dbCountAfter2.rows[0].n === 1);

  // ── Слой 2: живой браузер - бейдж/уведомление/переход к карточке мастера ──
  await withStaticServer(apiUrl, async (base) => {
    await withBrowser(async (s) => {
      await s.navigate(`${base}/crm-owner.html`);
      await s.setViewport(1280, 900, true);
      await sleep(400);

      await s.type('#loginEmail', 'verify-owner-o35@test.local');
      await s.type('#loginPin', ownerPin);
      await s.click('#loginForm button[type="submit"]');
      await sleep(700); // login + wireNotifications refreshBadge

      const badgeText = await s.eval(`document.getElementById('msgBellBadge')?.textContent`);
      const badgeHidden = await s.eval(`document.getElementById('msgBellBadge')?.hidden`);
      check('бейдж колокольчика виден и показывает непрочитанное', badgeHidden === false && Number(badgeText) >= 1);

      await s.click('#msgBell');
      await sleep(400); // renderList()

      const itemTitle = await s.eval(`document.querySelector('.msg-item .msg-title')?.textContent`);
      const itemIcon = await s.eval(`document.querySelector('.msg-item .msg-ico')?.textContent`);
      check('в списке уведомлений виден пункт про пропавший график', typeof itemTitle === 'string' && itemTitle.includes('Мамедхан'));
      check('иконка уведомления - ⚠️, не дефолтный 🔔', itemIcon === '⚠️');

      await s.screenshot('/tmp/okno35-bell-open-alert.png');

      // Клик по уведомлению - ведёт прямым действием к карточке мастера.
      await s.click('.msg-item');
      await sleep(500); // smooth scroll

      const tabChecked = await s.eval(`document.getElementById('pt-b')?.checked`);
      const cardOpen = await s.eval(`document.getElementById('staffCard-master-2')?.open`);
      const panelClosed = await s.eval(`!document.getElementById('msgPanel')?.classList.contains('open')`);
      check('клик по уведомлению переключает на вкладку "Сотрудники"', tabChecked === true);
      check('клик по уведомлению открывает карточку master-2 (details.open)', cardOpen === true);
      check('панель уведомлений закрылась после клика (не мешает смотреть карточку)', panelClosed === true);

      await sleep(200);
      await s.screenshot('/tmp/okno35-master-card-opened.png');

      // Прочитано - при повторном открытии колокольчика бейдж должен обнулиться.
      const badgeAfterClick = await s.eval(`document.getElementById('msgBellBadge')?.textContent`);
      check('после клика уведомление помечено прочитанным (бейдж обнулился)', badgeAfterClick === '0');
    });
  });
});
} catch (err) {
  crashed = true;
  console.error('Прогон упал с ошибкой:', err);
}
process.exit(summary() && !crashed ? 0 : 1);
