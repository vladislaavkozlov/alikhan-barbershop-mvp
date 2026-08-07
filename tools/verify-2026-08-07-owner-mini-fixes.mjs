// Живая проверка пакета мелких фронтенд-правок владельца (07.08.2026, прямые правки
// Влада, 11 пунктов): дубли заголовков, скачущая высота "День", текст в заявках
// мастеров, новая вкладка "Уведомления", иконка сообщений, адрес в шапке,
// сворачиваемость по умолчанию, перенос "Как приходят клиенты" в "Аналитику",
// сворачиваемые блоки "Финансов" + удаление "Настройка ЗП".
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withEphemeralServer(async ({ apiUrl, db }) => {
  const pinOwner = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ('smoke-owner', NULL, 'QA Владелец', 'owner', true, false, true, 'smoke-owner@test.local', $1)`,
    [hashPin(pinOwner)]
  );
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT m.id, wd, true, '10:00', '20:00'
     FROM (VALUES ('master-1'), ('master-2'), ('master-3')) AS m(id), generate_series(1, 7) AS wd`
  );

  await withStaticServer(apiUrl, async (base) => {
    await withBrowser(async (s) => {
      await s.navigate(`${base}/crm-owner.html`);
      await s.setViewport(1440, 1000, true);
      await sleep(400);
      await s.type('#loginEmail', 'smoke-owner@test.local');
      await s.type('#loginPin', pinOwner);
      await s.click('#loginForm button[type="submit"]');
      await sleep(1300);

      // ── sidebar: 5 пунктов, включая новое "Уведомления" ──────────────────
      const labels = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('.app-nav-label')].map(e => e.textContent.trim()))`));
      check('Sidebar содержит "Уведомления"', labels.includes('Уведомления'), JSON.stringify(labels));
      check('Sidebar: ровно 5 пунктов', labels.length === 5, JSON.stringify(labels));

      // ── адрес убран из шапки ──────────────────────────────────────────
      const hasAddress = await s.eval(`document.body.textContent.includes('Андрея Голуба')`);
      check('Адрес "Андрея Голуба" убран из шапки', !hasAddress);

      // ── иконка колокольчика реально видима ────────────────────────────
      await sleep(300);
      const bellIconRect = JSON.parse(await s.eval(`JSON.stringify(document.querySelector('#msgBellIcon svg')?.getBoundingClientRect() ?? null)`));
      check('Иконка колокольчика существует и имеет ненулевой размер', !!bellIconRect && bellIconRect.width > 0 && bellIconRect.height > 0 && bellIconRect.width < 38, JSON.stringify(bellIconRect));

      // ── Расписание: без дублей заголовка "Расписание" ────────────────
      const scheduleH1 = await s.eval(`document.getElementById('shellSectionTitle').textContent.trim()`);
      const scheduleH2Count = await s.eval(`[...document.querySelectorAll('.panel-a h2')].filter(h => h.textContent.trim() === 'Расписание').length`);
      check('Топбар показывает "Расписание"', scheduleH1 === 'Расписание', scheduleH1);
      check('В панели "Расписание" нет второго <h2>Расписание</h2>', scheduleH2Count === 0, `найдено ${scheduleH2Count}`);

      // ── заявки мастеров: убраны из Расписания, текст про "Отменить" убран ──
      const oldNoteGone = await s.eval(`!document.body.textContent.includes('«Отменить» возвращает дни к стандартному графику')`);
      check('Строка про "Отменить" убрана', oldNoteGone);
      const reqListInPanelA = await s.eval(`!!document.querySelector('.panel-a #ownerReqList')`);
      check('Заявки мастеров больше НЕ в панели "Расписание"', !reqListInPanelA);
      const reqListInPanelE = await s.eval(`!!document.querySelector('.panel-e #ownerReqList')`);
      check('Заявки мастеров теперь в панели "Уведомления"', reqListInPanelE);

      // ── переключение на "Уведомления" реально показывает список ──────
      await s.eval(`window.crmGoToSection('notifications')`, false);
      await sleep(300);
      const panelEVisible = await s.eval(`getComputedStyle(document.querySelector('.panel-e')).display !== 'none'`);
      check('Клик по "Уведомления" показывает panel-e', panelEVisible);

      // ── День: клик по пустому слоту не сдвигает сам календарь ────────
      await s.eval(`window.crmGoToSection('schedule')`, false);
      await sleep(300);
      const docTop = async () => Number(await s.eval(`(document.querySelector('.schedule-track').getBoundingClientRect().top + window.scrollY).toFixed(1)`));
      const trackDocTopBefore = await docTop();
      // клик по пустой точке трека (не на существующую запись)
      await s.eval(`
        (function() {
          const track = document.querySelector('.schedule-track');
          const rect = track.getBoundingClientRect();
          const ev = new MouseEvent('click', { clientX: rect.left + 20, clientY: rect.top + 300, bubbles: true });
          track.dispatchEvent(ev);
        })()
      `);
      await sleep(700); // scrollIntoView smooth
      const walkinShown = await s.eval(`document.getElementById('walkinForm').hidden === false`);
      const trackDocTopAfter = await docTop();
      check('Клик по пустому слоту открывает форму walk-in', walkinShown);
      check(
        'После открытия формы walk-in календарь "День" НЕ сдвинулся в ДОКУМЕНТЕ (форма не толкает его, хотя вьюпорт может проскроллиться к форме)',
        trackDocTopBefore === trackDocTopAfter,
        `до: ${trackDocTopBefore}, после: ${trackDocTopAfter}`
      );

      // ── Команда: все карточки мастеров свёрнуты по умолчанию ─────────
      await s.eval(`window.crmGoToSection('team')`, false);
      await sleep(300);
      const teamH2Count = await s.eval(`[...document.querySelectorAll('.panel-b h2')].filter(h => h.textContent.trim() === 'Команда').length`);
      check('В панели "Команда" нет дублирующего <h2>Команда</h2>', teamH2Count === 0, `найдено ${teamH2Count}`);
      const openStaffCards = await s.eval(`document.querySelectorAll('.staff-card[open]').length`);
      check('Ни одна карточка мастера не открыта по умолчанию', openStaffCards === 0, `открыто: ${openStaffCards}`);
      const wiInTeam = await s.eval(`document.body.textContent.includes('Как приходят клиенты')`);
      const wiStillInStaffCard = await s.eval(`!!document.querySelector('#staffCard-master-1 .staff-card-body')?.textContent.includes('Как приходят клиенты')`);
      check('"Как приходят клиенты" реально убран из карточки мастера-1', !wiStillInStaffCard);

      // ── Аналитика: без дублей заголовка, оба блока свёрнуты, "Как приходят клиенты" на месте ──
      await s.eval(`window.crmGoToSection('analytics')`, false);
      await sleep(300);
      const analyticsH2Count = await s.eval(`[...document.querySelectorAll('.panel-d h2')].filter(h => h.textContent.trim() === 'Аналитика').length`);
      check('В панели "Аналитика" нет дублирующего <h2>Аналитика</h2>', analyticsH2Count === 0, `найдено ${analyticsH2Count}`);
      const analyticsCards = await s.eval(`document.querySelectorAll('.panel-d .staff-card').length`);
      const analyticsOpenCards = await s.eval(`document.querySelectorAll('.panel-d .staff-card[open]').length`);
      check('В "Аналитике" ровно 2 сворачиваемых блока', analyticsCards === 2, `найдено ${analyticsCards}`);
      check('Оба блока "Аналитики" свёрнуты по умолчанию', analyticsOpenCards === 0, `открыто: ${analyticsOpenCards}`);
      check('"Как приходят клиенты" теперь в "Аналитике"', wiInTeam);
      const rtStillPresent = await s.eval(`document.body.textContent.includes('Возвращаемость клиентов')`);
      check('"Возвращаемость клиентов" осталась в "Аналитике"', rtStillPresent);

      // ── Финансы: Выручка/Зарплаты мастеров свёрнуты, Настройка ЗП удалена ──
      await s.eval(`window.crmGoToSection('finance')`, false);
      await sleep(300);
      const financeCards = await s.eval(`document.querySelectorAll('.panel-c .staff-card').length`);
      const financeOpenCards = await s.eval(`document.querySelectorAll('.panel-c .staff-card[open]').length`);
      check('В "Финансах" ровно 2 сворачиваемых блока (Выручка, Зарплаты мастеров)', financeCards === 2, `найдено ${financeCards}`);
      check('Оба блока "Финансов" свёрнуты по умолчанию', financeOpenCards === 0, `открыто: ${financeOpenCards}`);
      const settingsGone = await s.eval(`!document.body.textContent.includes('Настройка ЗП')`);
      check('"Настройка ЗП" удалена целиком', settingsGone);
      const deadLinkGone = await s.eval(`!document.querySelector('a[href="#nastroika-zp"]')`);
      check('Мёртвая ссылка "Перейти к настройке ЗП" удалена', deadLinkGone);

      // ── скриншоты всех затронутых вкладок ──────────────────────────────
      await s.eval(`window.crmGoToSection('schedule')`, false);
      await sleep(300);
      await s.screenshot('/tmp/after-schedule.png');
      await s.eval(`window.crmGoToSection('team')`, false);
      await sleep(300);
      await s.screenshot('/tmp/after-team.png');
      await s.eval(`window.crmGoToSection('finance')`, false);
      await sleep(300);
      await s.screenshot('/tmp/after-finance.png');
      await s.eval(`window.crmGoToSection('analytics')`, false);
      await sleep(300);
      await s.screenshot('/tmp/after-analytics.png');
      await s.eval(`window.crmGoToSection('notifications')`, false);
      await sleep(300);
      await s.screenshot('/tmp/after-notifications.png');
    });
  });
});

summary();
