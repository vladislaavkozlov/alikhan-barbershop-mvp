// Диагностика 17.08.2026, второй заход - кабинет УПРАВЛЯЮЩЕГО (Мамедхан, master-2,
// role=manager, открывает тот же crm-owner.html). Влад: «я увидел ошибку в боевом
// кабинете управляющего» - должность вида «Владелец + Мастер». Первый прогон
// (diag-2026-08-17-kabinety.mjs) управляющего не проверял вовсе, снимаем его DOM.
import { withBrowser } from './cdp.mjs';

// Окно 72 (28.08.2026): боевые логины и пароли убраны из кода - репозиторий публичный,
// а до этой правки пароли всех пятерых сотрудников салона лежали здесь открытым
// текстом. Скрипт берёт доступы из окружения, например:
//   OWNER_LOGIN=aliovsad OWNER_PIN=<пароль> node tools/diag-2026-08-17-upravlyayushchiy.mjs
const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задан доступ ${name}. Пример: ${name}=<значение> node tools/diag-2026-08-17-upravlyayushchiy.mjs`);
    process.exit(1);
  }
  return value;
};


const BASE = 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const ACCOUNT = { page: 'crm-owner.html', email: env('MANAGER_LOGIN'), pin: env('MANAGER_PIN') };

async function waitFor(s, selector, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await s.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await s.sleep(250);
  }
  return false;
}

// Всё, что похоже на должность/роль: подпись под именем, бейджи, radio-список ролей,
// поля «Должность». Берём вместе с признаком видимости - скрытая вкладка тоже часть
// кабинета, но Влад видит только раскрытую
const ROLES = `[...document.querySelectorAll('.staff-list .staff-card')].map((card) => ({
  name: card.querySelector('.summary-meta .name')?.textContent.trim(),
  подпись: card.querySelector('.summary-meta .role')?.textContent.trim(),
  бейджи: [...card.querySelectorAll('.summary-badges .badge, .badge')].map((b) => b.textContent.trim()),
  ролиВДоступе: [...card.querySelectorAll('.team-role-option, .role-option')].map((o) => o.textContent.trim().replace(/\\s+/g, ' ')),
  поляДолжность: [...card.querySelectorAll('.field')].filter((f) => /должност/i.test(f.querySelector('label')?.textContent ?? '')).map((f) => f.querySelector('input')?.value),
}))`;

const PLUS = `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walk.nextNode())) {
    const text = node.textContent.trim();
    if (!/\\+\\s*(Мастер|мастер)|Мастер\\s*\\+/.test(text)) continue;
    const el = node.parentElement;
    out.push({ text: text.slice(0, 80), cls: el?.className, tag: el?.tagName, скрыт: el?.offsetParent === null });
  }
  return out;
})()`;

await withBrowser(async (s) => {
  await s.navigate(`${BASE}/${ACCOUNT.page}`);
  if (!await waitFor(s, '#loginEmail')) throw new Error('нет формы логина');
  await s.type('#loginEmail', ACCOUNT.email);
  await s.type('#loginPin', ACCOUNT.pin);
  await s.click('#loginBtn, button[type=submit], .login-submit');
  await s.sleep(4000);
  console.log('вход как:', await s.eval(`document.querySelector('.app-user-name, .user-name, [data-user-name]')?.textContent.trim() ?? location.pathname`));
  console.log('\n--- карточки и должности ---');
  console.log(JSON.stringify(await s.eval(ROLES), null, 1));
  console.log('\n--- где на экране «+ Мастер» ---');
  console.log(JSON.stringify(await s.eval(PLUS), null, 1));
  await s.screenshot('/tmp/diag-manager.png');
});
