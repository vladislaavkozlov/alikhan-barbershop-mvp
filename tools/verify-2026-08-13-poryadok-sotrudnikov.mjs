// Живая проверка порядка сотрудников (13.08.2026): в списке команды и в колонках
// дня сотрудники идут по времени появления - самые давние сверху/слева, только что
// созданные снизу/справа. Проверяем и на исторических записях (master-1..3, у них
// created_at одинаковый и порядок держит id), и на аккаунтах, созданных через
// настоящую форму «Добавить сотрудника» уже в этом прогоне.
import { withBrowser } from './cdp.mjs';
import { hashPin, makeChecker, randomPin, withEphemeralServer, withStaticServer } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    // Владельца заводим ПЕРВЫМ - он должен остаться выше всех, кого создадим после
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('qa-order-owner', 1, 'QA Владелец Порядок', 'owner', true, false, true, 'qa-order-owner@test.local', $1)`,
      [hashPin(ownerPin)],
    );

    const seeded = await db.query('SELECT id, name, created_at FROM staff ORDER BY created_at, id');
    check('Колонка created_at появилась у всех сотрудников', seeded.rows.every((row) => row.created_at instanceof Date), JSON.stringify(seeded.rows.map((r) => r.id)));

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (session) => {
        await session.setViewport(1440, 1100, false);
        await session.navigate(`${base}/crm-owner.html`);
        await session.type('#loginEmail', 'qa-order-owner@test.local');
        await session.type('#loginPin', ownerPin);
        await session.click('#loginForm button[type="submit"]');
        await sleep(1600);
        await session.setViewport(1440, 1100, false);
        await session.click('.app-nav-item[data-section="team"]');
        await sleep(1000);

        const before = await session.eval(`[...document.querySelectorAll('.team-editor-card .summary-meta .name')].map((n) => n.textContent.trim())`);
        check('Исторические сотрудники идут в порядке появления', JSON.stringify(before.slice(0, 3)) === JSON.stringify(['Алиовсад', 'Мамедхан', 'Елизавета']), JSON.stringify(before));

        // Заводим двух сотрудников настоящей формой, по очереди - именно так это
        // делает владелец, и именно этот путь должен класть их вниз списка
        const created = [];
        // email строим по индексу латиницей: замена кириллицы регуляркой даёт обоим
        // одинаковый адрес, и второй аккаунт молча не создаётся (email unique)
        const newcomers = [['QA Новичок Первый', 'qa-newcomer-1@test.local'], ['QA Новичок Второй', 'qa-newcomer-2@test.local']];
        for (const [name, email] of newcomers) {
          const result = await session.eval(`(async () => {
            const card = document.querySelector('.team-add-card');
            card.setAttribute('open', '');
            const value = (n) => card.querySelector('[name="' + n + '"]');
            value('name').value = ${JSON.stringify(name)};
            value('phone').value = '89031112233';
            value('phone').dispatchEvent(new Event('input', { bubbles: true }));
            value('email').value = ${JSON.stringify(email)};
            card.querySelector('[data-create]').click();
            await new Promise((r) => setTimeout(r, 2200));
            return [...document.querySelectorAll('.team-editor-card .summary-meta .name')].map((n) => n.textContent.trim());
          })()`, true);
          created.push(result);
          await sleep(400);
        }

        const afterFirst = created[0];
        const afterSecond = created[1];
        check('Первый созданный аккаунт встал в самый низ списка', afterFirst[afterFirst.length - 1] === 'QA Новичок Первый', JSON.stringify(afterFirst));
        check('Второй созданный встал ещё ниже, первый остался над ним', afterSecond.slice(-2).join(' | ') === 'QA Новичок Первый | QA Новичок Второй', JSON.stringify(afterSecond));
        check('Порядок исторических сотрудников не сдвинулся', JSON.stringify(afterSecond.slice(0, 3)) === JSON.stringify(['Алиовсад', 'Мамедхан', 'Елизавета']), JSON.stringify(afterSecond));

        // Правка карточки не должна тасовать список: раньше именно UPDATE переставлял
        // строку в куче Postgres и поднимал сотрудника наверх
        const afterEdit = await session.eval(`(async () => {
          const card = document.querySelector('.team-editor-card[data-staff-id="master-2"]');
          card.setAttribute('open', '');
          const input = card.querySelector('input[name="experience"]');
          input.value = 'проверка порядка';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          card.querySelector('[data-save]').click();
          await new Promise((r) => setTimeout(r, 2600));
          return [...document.querySelectorAll('.team-editor-card .summary-meta .name')].map((n) => n.textContent.trim());
        })()`, true);
        check('После сохранения карточки список остаётся в том же порядке', JSON.stringify(afterEdit) === JSON.stringify(afterSecond), `после правки=${JSON.stringify(afterEdit)} было=${JSON.stringify(afterSecond)}`);

        // Колонки дня: тот же порядок, только слева направо. Ставим новичкам график и
        // приём клиентов, иначе они законно не попадают в расписание
        const scheduled = await db.query(`SELECT id FROM staff WHERE name LIKE 'QA Новичок%' OR id IN ('master-1','master-2') ORDER BY created_at, id`);
        for (const row of scheduled.rows) {
          await db.query(
            `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
             SELECT $1, g, true, '10:00', '20:00' FROM generate_series(1,7) g
             ON CONFLICT DO NOTHING`,
            [row.id],
          );
        }
        await db.query(`UPDATE staff SET provides_services = true WHERE name LIKE 'QA Новичок%' OR id IN ('master-1','master-2')`);

        await session.navigate(`${base}/crm-owner.html`);
        await sleep(1200);
        await session.type('#loginEmail', 'qa-order-owner@test.local');
        await session.type('#loginPin', ownerPin);
        await session.click('#loginForm button[type="submit"]');
        await sleep(2600);
        await session.setViewport(1440, 1100, false);
        await session.click('.app-nav-item[data-section="schedule"]');
        await sleep(1800);

        // Панель «День» раскрываем - иначе колонки существуют в DOM, но кадр для
        // человека будет пустым
        await session.eval(`document.querySelector('.panel-sp-day')?.closest('details')?.setAttribute('open','')`);
        await sleep(900);
        const columns = await session.eval(`(() => {
          const heads = [...document.querySelectorAll('.panel-sp-day .schedule-col .schedule-col-head .name')];
          const names = heads.map((h) => h.textContent.trim());
          return { names, count: document.querySelectorAll('.panel-sp-day .schedule-col').length };
        })()`);
        const order = columns.names.filter(Boolean);
        check('Колонки дня идут слева направо в том же порядке появления', order.indexOf('QA Новичок Первый') >= 0 && order.indexOf('QA Новичок Первый') < order.indexOf('QA Новичок Второй'), JSON.stringify(columns));
        check('Исторические мастера остаются левее новых', order[0] === 'Алиовсад' && order.indexOf('Мамедхан') === 1, JSON.stringify(columns));
        await session.screenshot('/tmp/poryadok-den.png');
      });
    });
  });
} catch (error) {
  console.error('CRASH:', error);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
