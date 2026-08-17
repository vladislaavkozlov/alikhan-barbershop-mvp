// Разовая диагностика 17.08.2026 - что РЕАЛЬНО на экране у администратора и владельца
// на боевом GitHub Pages. Влад прислал 7 правок кабинета ("пример" рядом с именами,
// "Оказывает услуги"/"Доступ к сервису", роль Алиовсада, пункт "Точка", финансы у
// администратора, зарплата у мастера, "Управление скидками") - grep по локальному
// репозиторию часть из них не находит вовсе, значит смотреть надо живой DOM прода.
// Не тест, ничего не ассертит: печатает срез экрана, чтобы правки шли по факту.
import { withBrowser } from './cdp.mjs';

const BASE = 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const ACCOUNTS = {
  admin: { page: 'crm-admin.html', email: 'master4-test@alikhan.test', pin: '517563' },
  owner: { page: 'crm-owner.html', email: 'master1-test@alikhan.test', pin: '4495' },
  master: { page: 'crm-master.html', email: 'master3-test@alikhan.test', pin: '0708' },
};

// Форму логина рисует crm-auth.js уже после загрузки страницы - фиксированной паузы
// на проде не хватает (память reference_barbershop-crm-tech), ждём поле циклом
async function waitFor(s, selector, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await s.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await s.sleep(250);
  }
  return false;
}

async function login(s, { page, email, pin }) {
  await s.navigate(`${BASE}/${page}`);
  if (!await waitFor(s, '#loginEmail')) throw new Error(`нет формы логина на ${page}`);
  await s.type('#loginEmail', email);
  await s.type('#loginPin', pin);
  await s.click('#loginBtn, button[type=submit], .login-submit');
  // Раздел «Сотрудники» рисуется по событию crm:authenticated асинхронно из GET /staff
  await s.sleep(3500);
}

// Все вкладки верхнего меню - чтобы понять, какие разделы человек вообще видит
const TABS = `[...document.querySelectorAll('.tab-label, .tabs label, [role=tab], .app-nav a, .app-nav button')]
  .map((el) => el.textContent.trim()).filter(Boolean)`;

// Карточки сотрудников: имя + подпись под именем + заголовки секций внутри
const CARDS = `[...document.querySelectorAll('.staff-list .staff-card')].map((card) => ({
  name: card.querySelector('.summary-meta .name')?.textContent.trim(),
  sub: card.querySelector('.summary-meta .role')?.textContent.trim(),
  sections: [...card.querySelectorAll('h4, .team-section-head strong, .team-section-title, .section-title')].map((h) => h.textContent.trim()),
  toggles: [...card.querySelectorAll('.tr-label, .team-toggle-title, .toggle-row strong')].map((t) => t.textContent.trim().split('\\n')[0]),
}))`;

// Где на странице вообще встречается слово «пример» - с путём до элемента
const PRIMER = `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walk.nextNode())) {
    const text = node.textContent.trim();
    if (!/пример/i.test(text)) continue;
    const el = node.parentElement;
    if (!el || el.offsetParent === null) continue;
    out.push({ text: text.slice(0, 80), cls: el.className, tag: el.tagName, near: el.closest('.staff-card')?.querySelector('.summary-meta .name')?.textContent.trim() ?? null });
  }
  return out;
})()`;

const FIND = (needle) => `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walk.nextNode())) {
    if (!node.textContent.includes(${JSON.stringify(needle)})) continue;
    const el = node.parentElement;
    out.push({ text: node.textContent.trim().slice(0, 90), cls: el?.className, hidden: el?.offsetParent === null });
  }
  return out;
})()`;

function show(title, value) {
  console.log(`\n--- ${title} ---`);
  console.log(JSON.stringify(value, null, 1));
}

await withBrowser(async (s) => {
  for (const role of ['admin', 'owner', 'master']) {
    console.log(`\n\n================ ${role.toUpperCase()} (${ACCOUNTS[role].page}) ================`);
    await login(s, ACCOUNTS[role]);
    show('вкладки', await s.eval(TABS));
    show('карточки сотрудников', await s.eval(CARDS));
    show('слово «пример» на экране', await s.eval(PRIMER));
    for (const needle of ['Точка', 'Оказывает услуги', 'Доступ к сервису', 'Управление скидками', 'Зарплат', 'зарплат', 'Выручка', 'Финанс']) {
      const hits = await s.eval(FIND(needle));
      if (hits.length) show(`текст «${needle}»`, hits.slice(0, 6));
    }
    await s.screenshot(`/tmp/diag-${role}.png`);
  }
});
