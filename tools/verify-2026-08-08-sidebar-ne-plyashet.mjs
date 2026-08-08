// Живая проверка правки 08.08.2026 (Влад: "кнопки панели меню пляшут вверх-вниз
// при открытии и закрытии") - причина: при развороте sidebar подпись
// (.app-nav-label) мгновенно становилась видимой (снимается display:none), а
// ширина .app-sidebar ещё только начинала анимироваться 76px→240px (180ms) -
// пару кадров подпись не помещалась и переносилась на вторую строку, кнопки ниже
// сдвигались вниз и обратно. white-space:nowrap на .app-nav-item запрещает
// перенос - лишний текст обрезается, а не переносится, высота кнопки больше не
// может измениться. Снимаем позицию каждой кнопки покадрово во время анимации.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('nj-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'nj-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'nj-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        const snapshot = `[...document.querySelectorAll('.app-nav-item')].map((b) => Math.round(b.getBoundingClientRect().top))`;

        // Сворачиваем сначала - самый рискованный переход (развёртывание,
        // подпись появляется мгновенно, ширина ещё узкая) проверяем следующим.
        await s.click('#appSidebarToggle');
        await sleep(250);

        // ── Разворот: снимаем позиции каждые 20ms на всём протяжении transition (180ms) ──
        await s.click('#appSidebarToggle');
        const frames = [];
        for (let i = 0; i < 12; i++) {
          frames.push(await s.eval(snapshot));
          await sleep(20);
        }
        const allFramesIdentical = frames.every((f) => JSON.stringify(f) === JSON.stringify(frames[0]));
        check(
          'При развороте sidebar позиции всех 5 кнопок не меняются ни на одном кадре анимации (нет "пляски")',
          allFramesIdentical,
          JSON.stringify(frames)
        );

        // ── Текст подписи не переносится на вторую строку ни в одном состоянии ──
        await sleep(300);
        const noWrapExpanded = await s.eval(`
          [...document.querySelectorAll('.app-nav-item')].every((b) => Math.round(b.getBoundingClientRect().height) <= 45)
        `);
        check('Развёрнуто: высота каждой кнопки одинарная (текст не перенёсся на 2 строки)', noWrapExpanded === true, `${noWrapExpanded}`);

        await s.screenshot('/tmp/verify-sidebar-no-jump.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
