// Живая регрессия общего визуального слоя CRM: три роли, открытое/закрытое
// состояние аккордеонов, верхние действия, предупреждение владельца и mobile
import { withBrowser } from './cdp.mjs';
import { hashPin, makeChecker, randomPin, withEphemeralServer, withStaticServer } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function visualSnapshotSource() {
  return `(() => {
    const cards = [...document.querySelectorAll('details.staff-card')];
    const open = cards.find((card) => card.open);
    const closed = cards.find((card) => !card.open);
    const openIcon = open?.querySelector('.avatar-icon');
    const openChevron = open?.querySelector('.chevron');
    const topActions = [...document.querySelectorAll('.nav-right .crm-top-action')]
      .filter((node) => getComputedStyle(node).display !== 'none');
    const actionStyles = topActions.map((node) => {
      const style = getComputedStyle(node);
      return {
        height: Math.round(node.getBoundingClientRect().height),
        radius: style.borderRadius,
        border: style.borderTopWidth,
      };
    });
    return {
      cardCount: cards.length,
      bodyClass: document.body.classList.contains('crm-navigation-ui'),
      openRailOpacity: open ? getComputedStyle(open, '::before').opacity : null,
      openRadius: open ? getComputedStyle(open).borderRadius : null,
      closedRailOpacity: closed ? getComputedStyle(closed, '::before').opacity : null,
      openIconBackground: openIcon ? getComputedStyle(openIcon).backgroundColor : null,
      chevronBox: openChevron ? Math.round(openChevron.getBoundingClientRect().width) : null,
      chevronDirection: openChevron ? getComputedStyle(openChevron, '::before').transform : null,
      topActions: actionStyles,
      topActionsInsideViewport: topActions.every((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= window.innerWidth;
      }),
      pageFits: document.documentElement.scrollWidth <= window.innerWidth,
    };
  })()`;
}

async function login(session, base, page, email, pin) {
  await session.setViewport(1440, 1100, false);
  await session.navigate(`${base}/${page}`);
  await session.type('#loginEmail', email);
  await session.type('#loginPin', pin);
  await session.click('#loginForm button[type="submit"]');
  await sleep(1300);
}

async function checkRole({ base, page, email, pin, section, expectedCards, screenshot }) {
  await withBrowser(async (session) => {
    await login(session, base, page, email, pin);
    if (section) {
      await session.click(`.app-nav-item[data-section="${section}"]`);
      await sleep(250);
    }
    await session.eval(`(() => {
      const visibleCards = [...document.querySelectorAll('details.staff-card')]
        .filter((card) => card.closest('.tab-panel') ? getComputedStyle(card.closest('.tab-panel')).display !== 'none' : true);
      visibleCards.forEach((card, index) => { card.open = index === 0; });
    })()`);
    await sleep(180);

    const view = await session.eval(visualSnapshotSource());
    check(`${page}: подключён общий класс и найдено ${expectedCards} панелей`, view.bodyClass && view.cardCount === expectedCards, JSON.stringify(view));
    check(`${page}: раскрытая панель имеет золотой rail, закрытая его скрывает`, view.openRailOpacity === '1' && (view.closedRailOpacity === '0' || view.closedRailOpacity === null), JSON.stringify(view));
    check(`${page}: панель и шеврон используют утверждённую геометрию`, view.openRadius === '14px' && view.chevronBox === 32 && view.chevronDirection !== 'none', JSON.stringify(view));
    check(`${page}: видимые верхние действия имеют общий размер и рамку`, view.topActions.length >= 4 && view.topActions.every((item) => item.height === 38 && item.radius === '10px' && item.border === '1px'), JSON.stringify(view));
    check(`${page}: верхние действия целиком помещаются во viewport`, view.topActionsInsideViewport, JSON.stringify(view));
    check(`${page}: desktop не создаёт горизонтальный скролл страницы`, view.pageFits, JSON.stringify(view));
    await session.screenshot(screenshot);

    await session.setViewport(390, 844, true);
    await sleep(250);
    const mobile = await session.eval(visualSnapshotSource());
    check(`${page}: mobile не создаёт горизонтальный скролл страницы`, mobile.pageFits, JSON.stringify(mobile));
  });
  await sleep(300);
}

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    const adminPin = randomPin();
    const masterPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('nav-owner', 1, 'QA Владелец Навигация', 'owner', true, false, true, 'nav-owner@test.local', $1),
       ('nav-admin', 1, 'QA Администратор Навигация', 'admin', true, false, true, 'nav-admin@test.local', $2),
       ('nav-master', 1, 'QA Мастер Без Графика', 'master', true, true, true, 'nav-master@test.local', $3)`,
      [hashPin(ownerPin), hashPin(adminPin), hashPin(masterPin)],
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (session) => {
        await login(session, base, 'crm-owner.html', 'nav-owner@test.local', ownerPin);
        await sleep(400);
        const alert = await session.eval(`(() => {
          const rows = [...document.querySelectorAll('.owner-schedule-alert')];
          const row = rows.find((item) => item.textContent.includes('QA Мастер Без Графика')) || rows[0];
          const button = row?.querySelector('[data-open-schedule-tab]');
          return {
            exists: !!row,
            title: row?.querySelector('strong')?.textContent.trim(),
            hasMaster: rows.some((item) => item.textContent.includes('QA Мастер Без Графика')),
            columns: row ? getComputedStyle(row).gridTemplateColumns : '',
            buttonRadius: button ? getComputedStyle(button).borderRadius : '',
          };
        })()`);
        check('Владелец: предупреждение о графике использует новый компонент', alert.exists && alert.title === 'Нет рабочего графика' && alert.hasMaster && alert.buttonRadius === '9px', JSON.stringify(alert));
        await session.click('.owner-schedule-alert [data-open-schedule-tab]');
        await sleep(150);
        const section = await session.eval(`document.body.dataset.shellSection`);
        check('Владелец: «Настроить график» по-прежнему открывает Команду', section === 'team', String(section));
      });
      await sleep(300);

      await checkRole({ base, page: 'crm-owner.html', email: 'nav-owner@test.local', pin: ownerPin, section: 'schedule', expectedCards: 12, screenshot: '/tmp/crm-navigation-owner.png' });
      await checkRole({ base, page: 'crm-admin.html', email: 'nav-admin@test.local', pin: adminPin, section: 'team', expectedCards: 2, screenshot: '/tmp/crm-navigation-admin.png' });
      await checkRole({ base, page: 'crm-master.html', email: 'nav-master@test.local', pin: masterPin, section: 'profile', expectedCards: 1, screenshot: '/tmp/crm-navigation-master.png' });
    });
  });
} catch (error) {
  console.error('CRASH:', error);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
