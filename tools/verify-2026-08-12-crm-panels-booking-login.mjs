import { withBrowser } from './cdp.mjs';
import { withStaticServer } from './verify-lib.mjs';

let failed = false;
function check(label, condition, details = '') {
  console.log(`${condition ? 'OK' : 'FAIL'}  ${label}${details ? ` - ${details}` : ''}`);
  if (!condition) failed = true;
}

await withStaticServer('http://127.0.0.1:9', async (base) => {
  await withBrowser(async (session) => {
    for (const page of ['crm-owner.html', 'crm-admin.html', 'crm-master.html']) {
      await session.setViewport(1440, 900, false);
      await session.navigate(`${base}/${page}`);
      const desktop = await session.eval(`(() => {
        const card = document.querySelector('.login-card');
        return {
          card: !!card,
          radius: card ? getComputedStyle(card).borderRadius : null,
          rail: card ? getComputedStyle(card, '::before').width : null,
          pageFits: document.documentElement.scrollWidth <= innerWidth,
          mainHidden: document.getElementById('crmMain').hidden,
        };
      })()`);
      check(`${page}: вход использует карточку 14 px и rail 3 px`, desktop.card && desktop.radius === '14px' && desktop.rail === '3px', JSON.stringify(desktop));
      check(`${page}: до входа CRM скрыта и desktop без X-scroll`, desktop.mainHidden && desktop.pageFits, JSON.stringify(desktop));

      await session.setViewport(390, 844, true);
      const mobile = await session.eval(`(() => {
        const card = document.querySelector('.login-card').getBoundingClientRect();
        return { pageFits: document.documentElement.scrollWidth <= innerWidth, cardFits: card.left >= 0 && card.right <= innerWidth };
      })()`);
      check(`${page}: mobile-вход помещается во viewport`, mobile.pageFits && mobile.cardFits, JSON.stringify(mobile));

      await session.setViewport(844, 390, true);
      const landscape = await session.eval(`(() => {
        const card = document.querySelector('.login-card').getBoundingClientRect();
        return { top: card.top, pageFits: document.documentElement.scrollWidth <= innerWidth, scrollable: document.querySelector('.login-gate').scrollHeight >= document.querySelector('.login-gate').clientHeight };
      })()`);
      check(`${page}: landscape-вход доступен от верхнего края и прокручивается`, landscape.top >= 0 && landscape.pageFits && landscape.scrollable, JSON.stringify(landscape));
    }

    await session.setViewport(1440, 1000, false);
    await session.navigate(`${base}/crm-master.html`);
    const masterPanels = await session.eval(`(() => ({
      cards: [...document.querySelectorAll('.panel-a .schedule-view-card')].map((card) => card.id),
      year: !!document.querySelector('.panel-a #scheduleCard-year'),
      notifications: document.querySelectorAll('#msgBell').length,
    }))()`);
    check('Мастер: три панели День/Неделя/Месяц без Года', masterPanels.cards.join(',') === 'scheduleCard-day,scheduleCard-week,scheduleCard-month' && !masterPanels.year, JSON.stringify(masterPanels));
    check('Мастер: одна рабочая кнопка уведомлений', masterPanels.notifications === 1, JSON.stringify(masterPanels));
    await session.click('.panel-a .panel-group-toggle');
    const expanded = await session.eval(`(() => ({
      open: [...document.querySelectorAll('.panel-a .schedule-view-card')].every((card) => card.open),
      text: document.querySelector('.panel-a .panel-group-toggle').textContent,
    }))()`);
    check('Общий контрол раскрывает все панели и меняет подпись', expanded.open && expanded.text === 'Свернуть все', JSON.stringify(expanded));
    await session.click('.panel-a .panel-group-toggle');
    const collapsed = await session.eval(`[...document.querySelectorAll('.panel-a .schedule-view-card')].every((card) => !card.open)`);
    check('Общий контрол сворачивает все панели обратно', collapsed);

    await session.navigate(`${base}/crm-owner.html`);
    await session.eval(`(() => {
      const card = document.getElementById('scheduleCard-booking');
      const form = document.getElementById('walkinForm');
      card.open = true;
      form.hidden = false;
      form.dataset.bookingId = 'old-booking';
      card.open = false;
    })()`);
    const closedBooking = await session.eval(`document.getElementById('walkinForm').hidden`);
    check('Закрытие панели Запись скрывает прежний режим формы', closedBooking);

    for (const [page, expected] of [['crm-owner.html', true], ['crm-admin.html', true], ['crm-master.html', false]]) {
      await session.navigate(`${base}/${page}`);
      const hasBooking = await session.eval(`!!document.getElementById('scheduleCard-booking')`);
      check(`${page}: доступ к панели Запись соответствует роли`, hasBooking === expected, String(hasBooking));
    }
  });
});

if (failed) process.exitCode = 1;
