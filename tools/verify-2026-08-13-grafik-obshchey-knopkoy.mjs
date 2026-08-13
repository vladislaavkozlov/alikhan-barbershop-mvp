// Живая проверка (13.08.2026): своей кнопки «Сохранить график» в карточке больше
// нет, а общая «Сохранить изменения» видит правки графика, реально их сохраняет и
// подтверждает сервером. Отдельно проверяем, что кнопка просыпается именно от
// правки графика (до этого она оставалась серой) и что чужие поля карточки при
// этом не портятся.
import { withBrowser } from './cdp.mjs';
import { hashPin, makeChecker, randomPin, withEphemeralServer, withStaticServer } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MASTER = 'qa-grafik-master';
const cardOf = `document.querySelector('.team-editor-card[data-staff-id="${MASTER}"]')`;

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('qa-grafik-owner', 1, 'QA Владелец График', 'owner', true, false, true, 'qa-grafik-owner@test.local', $1),
       ('${MASTER}', 1, 'QA Мастер График', 'master', true, true, true, 'qa-grafik-master@test.local', $2)`,
      [hashPin(ownerPin), hashPin(randomPin())],
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT $1, g, true, '10:00', '20:00' FROM generate_series(1,7) g ON CONFLICT DO NOTHING`,
      [MASTER],
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (session) => {
        await session.setViewport(1440, 1100, false);
        await session.navigate(`${base}/crm-owner.html`);
        await session.type('#loginEmail', 'qa-grafik-owner@test.local');
        await session.type('#loginPin', ownerPin);
        await session.click('#loginForm button[type="submit"]');
        await sleep(1600);
        await session.setViewport(1440, 1100, false);
        await session.click('.app-nav-item[data-section="team"]');
        await sleep(1000);
        await session.eval(`${cardOf}.setAttribute('open', '')`);
        await sleep(1400);

        const initial = await session.eval(`(() => {
          const card = ${cardOf};
          const buttons = [...card.querySelectorAll('button')].map((b) => b.textContent.trim());
          return {
            ownButton: buttons.filter((t) => t === 'Сохранить график').length,
            saveButtons: buttons.filter((t) => t.startsWith('Сохранить')),
            saveDisabled: card.querySelector('[data-save]')?.disabled,
            weeklyLoaded: card.querySelectorAll('.weekly-day-row').length,
          };
        })()`);
        check('Отдельной кнопки «Сохранить график» в карточке нет', initial.ownButton === 0, JSON.stringify(initial));
        check('Осталась одна кнопка сохранения на карточку', initial.saveButtons.length === 1 && initial.saveButtons[0] === 'Сохранить изменения', JSON.stringify(initial));
        check('Пока ничего не трогали, общая кнопка неактивна', initial.saveDisabled === true, JSON.stringify(initial));
        check('Недельный график загрузился (семь дней)', initial.weeklyLoaded === 7, JSON.stringify(initial));

        // Выключаем понедельник - это и есть «изменение в графике»
        const afterToggle = await session.eval(`(() => {
          const card = ${cardOf};
          const toggle = card.querySelector('[id$="-1-working"]');
          toggle.click();
          return { checked: toggle.checked, saveDisabled: card.querySelector('[data-save]').disabled };
        })()`);
        check('Правка графика будит общую кнопку', afterToggle.checked === false && afterToggle.saveDisabled === false, JSON.stringify(afterToggle));

        const saved = await session.eval(`(async () => {
          const card = ${cardOf};
          card.querySelector('[data-save]').click();
          await new Promise((r) => setTimeout(r, 3500));
          return {
            note: card.querySelector('[data-card-note]')?.textContent.trim(),
            monday: card.querySelector('[id$="-1-working"]')?.checked,
            saveDisabled: card.querySelector('[data-save]')?.disabled,
          };
        })()`, true);
        check('Общая кнопка сохранила и отчиталась', saved.note === 'Сохранено', JSON.stringify(saved));

        const stored = await db.query('SELECT is_working FROM master_weekly_schedule WHERE master_id = $1 AND weekday = 1', [MASTER]);
        check('Выходной понедельник реально доехал до базы', stored.rows[0]?.is_working === false, JSON.stringify(stored.rows));

        // Перезаходим на страницу - форма должна показать сохранённое состояние
        await session.navigate(`${base}/crm-owner.html`);
        await sleep(1200);
        await session.type('#loginEmail', 'qa-grafik-owner@test.local');
        await session.type('#loginPin', ownerPin);
        await session.click('#loginForm button[type="submit"]');
        await sleep(2600);
        await session.setViewport(1440, 1100, false);
        await session.click('.app-nav-item[data-section="team"]');
        await sleep(1200);
        await session.eval(`${cardOf}.setAttribute('open', '')`);
        await sleep(1500);
        const reopened = await session.eval(`(() => {
          const card = ${cardOf};
          return {
            monday: card.querySelector('[id$="-1-working"]')?.checked,
            mondayHint: card.querySelector('[id$="-1-offBadge"]')?.textContent.trim(),
            saveDisabled: card.querySelector('[data-save]')?.disabled,
          };
        })()`);
        check('После перезахода понедельник остался выходным', reopened.monday === false && reopened.mondayHint === 'Выходной, записи не будет', JSON.stringify(reopened));
        check('Свежая карточка снова с неактивной кнопкой', reopened.saveDisabled === true, JSON.stringify(reopened));

        // Правка обычного поля по-прежнему работает вместе с графиком
        const mixed = await session.eval(`(async () => {
          const card = ${cardOf};
          const experience = card.querySelector('input[name="experience"]');
          experience.value = '7 лет';
          experience.dispatchEvent(new Event('input', { bubbles: true }));
          const toggle = card.querySelector('[id$="-2-working"]');
          toggle.click();
          const wokeUp = card.querySelector('[data-save]').disabled === false;
          card.querySelector('[data-save]').click();
          await new Promise((r) => setTimeout(r, 3500));
          return { wokeUp, note: card.querySelector('[data-card-note]')?.textContent.trim() };
        })()`, true);
        const both = await db.query(
          `SELECT (SELECT is_working FROM master_weekly_schedule WHERE master_id = $1 AND weekday = 2) AS tuesday,
                  (SELECT experience_text FROM staff WHERE id = $1) AS experience`,
          [MASTER],
        );
        check('Одна кнопка сохраняет и поля карточки, и график разом', mixed.wokeUp && both.rows[0]?.tuesday === false && both.rows[0]?.experience === '7 лет', `${JSON.stringify(mixed)} ${JSON.stringify(both.rows)}`);

        await session.eval(`${cardOf}.querySelector('.weekly-panels')?.scrollIntoView({ block: 'center' })`);
        await sleep(400);
        await session.screenshot('/tmp/grafik-odna-knopka.png');
      });
    });
  });
} catch (error) {
  console.error('CRASH:', error);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
