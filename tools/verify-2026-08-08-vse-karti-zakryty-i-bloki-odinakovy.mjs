// Живая проверка финальной правки 08.08.2026 (после min-height:300 на 4 короткие
// вкладки, Влад указал: раз все карточки закрыты по умолчанию, "Расписание" тоже
// естественно ужимается - убрана единственная причина не трогать panel-a):
// 1) День/Неделя/Месяц/Запись (panel-a) и карточка "Заявки..." (panel-e) больше
//    НЕ открыты по умолчанию - ни один атрибут open на верхнеуровневых карточках
//    (scheduleCard-day/bd-1/panel-e), см. crm-owner.html.
// 2) контейнер (<section>) всех 5 вкладок теперь пиксель-в-пиксель одинаковый -
//    top/left/width/height совпадают при переключении между ними.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('ac-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'ac-owner@test.local', $1)`,
      [hashPin(pinOwner)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m.id, wd, true, '10:00', '20:00'
       FROM (VALUES ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
    );
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ac-owner@test.local', pin: pinOwner }),
    });
    if (res.status !== 200) throw new Error(`login → ${res.status}`);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1400, 1000, true);
        await sleep(400);
        await s.type('#loginEmail', 'ac-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1400);

        // ── 1) все верхнеуровневые карточки закрыты сразу после входа ──
        const openStates = await s.eval(`({
          day: document.getElementById('scheduleCard-day')?.open,
          week: document.getElementById('scheduleCard-week')?.open,
          month: document.getElementById('scheduleCard-month')?.open,
          zapis: document.getElementById('bd-1')?.open,
        })`);
        check(
          'Расписание: День/Неделя/Месяц/Запись все закрыты сразу после входа',
          Object.values(openStates).every((v) => v === false),
          JSON.stringify(openStates)
        );

        await s.click('.app-nav-item[data-section="notifications"]');
        await sleep(400);
        const notifOpen = await s.eval(`document.querySelector('.panel-e details.staff-card')?.open`);
        check('Уведомления: карточка "Заявки на изменение графика" закрыта по умолчанию', notifOpen === false, `open=${notifOpen}`);

        // ── 2) контейнер вкладки пиксель-в-пиксель одинаков во всех 5 разделах ──
        const panels = { schedule: 'panel-a', team: 'panel-b', finance: 'panel-c', analytics: 'panel-d', notifications: 'panel-e' };
        const rects = {};
        for (const [sec, cls] of Object.entries(panels)) {
          await s.click(`.app-nav-item[data-section="${sec}"]`);
          await sleep(350);
          rects[sec] = await s.eval(`
            (() => {
              const r = document.querySelector('.${cls} > section').getBoundingClientRect();
              return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
            })()
          `);
        }
        const values = Object.values(rects);
        const allSame = values.every((r) => JSON.stringify(r) === JSON.stringify(values[0]));
        check('Контейнер вкладки (top/left/width/height) идентичен во всех 5 разделах', allSame, JSON.stringify(rects));

        await s.screenshot('/tmp/verify-vse-zakryty.png');
      });
    });
  });
} catch (err) {
  console.error('FATAL:', err);
  process.exitCode = 1;
}

summary();
