// Живая проверка подписей разовых изменений графика в разделе «Команда» владельца
// (13.08.2026). Баг из аудита сценариев: строка списка печаталась как
// «20.08.2026 - Перерыв без перерыва» - у разовой правки ЧАСОВ работы (смена без
// перерывов) не было своей ветки, она попадала в ветку перерыва с пустым списком.
// Заодно проверяется выходной, закрытый окном ШИРЕ смены (fullDayOffWindow) -
// старая проверка равенством границ читала его как обычный длинный перерыв.
// Один withBrowser на весь прогон (порт отладки в cdp.mjs захардкожен).
import { withBrowser } from './cdp.mjs';
import { daysFromToday, hashPin, makeChecker, randomPin, withEphemeralServer, withStaticServer } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MASTER = 'qa-grafik-master';
// Карточку ищем по СВОЕМУ мастеру: миграции сеют собственных именных мастеров, и
// первая карточка в DOM - чужая (см. reference_barbershop-crm-tech.md).
const cardOf = (id) => `document.querySelector('.team-editor-card[data-staff-id="${id}"]')`;

// Даты считаются смещением от дня запуска, не литералами календаря - иначе прогон
// протухнет назавтра (список показывает только даты >= сегодня).
const DATE_HOURS = daysFromToday(3);   // правка часов, перерывов нет
const DATE_BREAK = daysFromToday(4);   // обычный обеденный перерыв
const DATE_DAYOFF = daysFromToday(5);  // выходной окном шире смены

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, phone, pin_hash) VALUES
       ('qa-grafik-owner', 1, 'QA Владелец График', 'owner', true, false, true, 'qa-grafik-owner@test.local', '89001112233', $1),
       ('${MASTER}', 1, 'QA Мастер График', 'master', true, true, true, 'qa-grafik-master@test.local', '89001234567', $2)`,
      [hashPin(ownerPin), hashPin(randomPin())],
    );

    const addShift = async (date, startTime, endTime, breaks) => {
      const shift = await db.query(
        'INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, $2, $3, $4) RETURNING id',
        [MASTER, date, startTime, endTime],
      );
      for (const b of breaks) {
        await db.query('INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, $2, $3)', [shift.rows[0].id, b[0], b[1]]);
      }
    };
    // Ровно то, что создаёт редактор дня в Месяце при снятой галочке «перерыв»:
    // POST /schedule со startTime/endTime и пустым breaks.
    await addShift(DATE_HOURS, '09:00', '18:00', []);
    await addShift(DATE_BREAK, '10:00', '20:00', [['13:00', '14:00']]);
    // Выходной, поставленный отгулом/праздником: fullDayOffWindow расширяет окно до
    // объединения смены и дефолта 10:00-20:00, перерыв получается шире смены.
    await addShift(DATE_DAYOFF, '09:00', '18:00', [['09:00', '20:00']]);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (session) => {
        await session.setViewport(1440, 1100, false);
        await session.navigate(`${base}/crm-owner.html`);
        await session.type('#loginEmail', 'qa-grafik-owner@test.local');
        await session.type('#loginPin', ownerPin);
        await session.click('#loginForm button[type="submit"]');
        await sleep(1600);
        // Реальная навигация после логина сбрасывает device metrics override
        await session.setViewport(1440, 1100, false);
        await session.click('.app-nav-item[data-section="team"]');
        await sleep(900);
        await session.eval(`${cardOf(MASTER)}?.setAttribute('open', '')`);
        // Список изменений грузится своим fetch при инициализации карточки - ждём
        // исчезновения заглушки «Загружаю изменения…», а не просто наличия узла.
        for (let i = 0; i < 40; i += 1) {
          const ready = await session.eval(`(() => {
            const list = ${cardOf(MASTER)}?.querySelector('[data-exception-list]');
            return !!list && !list.textContent.includes('Загружаю изменения');
          })()`);
          if (ready === true) break;
          await sleep(250);
        }

        const rows = await session.eval(`(() => {
          const list = ${cardOf(MASTER)}?.querySelector('[data-exception-list]');
          return {
            found: !!list,
            text: list?.textContent ?? '',
            items: [...(list?.querySelectorAll('.team-exception-item span') ?? [])].map((s) => s.textContent.trim()),
          };
        })()`);

        const human = (iso) => iso.split('-').reverse().join('.');
        const rowFor = (iso) => rows.items.find((t) => t.startsWith(human(iso))) ?? null;
        const raw = JSON.stringify(rows.items);

        check('Список разовых изменений мастера отрисован', rows.found && rows.items.length === 3, raw);
        check('Строки «Перерыв без перерыва» больше нет нигде в списке', !rows.text.includes('без перерыва'), rows.text);
        check(
          'Правка часов показана рабочим днём со временем смены',
          rowFor(DATE_HOURS) === `${human(DATE_HOURS)} - Рабочий день 09:00-18:00`,
          String(rowFor(DATE_HOURS)),
        );
        check(
          'У перерыва указано его время',
          rowFor(DATE_BREAK) === `${human(DATE_BREAK)} - Перерыв 13:00-14:00`,
          String(rowFor(DATE_BREAK)),
        );
        check(
          'Выходной окном шире смены назван выходным, а не длинным перерывом',
          rowFor(DATE_DAYOFF) === `${human(DATE_DAYOFF)} - Выходной`,
          String(rowFor(DATE_DAYOFF)),
        );

        await session.eval(`${cardOf(MASTER)}.querySelector('[data-exception-list]').scrollIntoView({ block: 'center' })`);
        await sleep(250);
        await session.screenshot('/tmp/team-grafik-podpisi.png');
      });
    });
  });
} finally {
  summary();
}
