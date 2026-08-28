// Разовый зонд по живому проду: вытаскивает точечные куски DOM кабинета,
// чтобы понять происхождение спорных надписей и состояние прав.
// Запуск: node tools/probe-2026-08-16.mjs <role> "<js-выражение>"
import { withBrowser } from './cdp.mjs';

// Окно 72 (28.08.2026): боевые логины и пароли убраны из кода - репозиторий публичный,
// а до этой правки пароли всех пятерых сотрудников салона лежали здесь открытым
// текстом. Скрипт берёт доступы из окружения, например:
//   OWNER_LOGIN=aliovsad OWNER_PIN=<пароль> node tools/probe-2026-08-16.mjs
const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задан доступ ${name}. Пример: ${name}=<значение> node tools/probe-2026-08-16.mjs`);
    process.exit(1);
  }
  return value;
};


// Окно 72 (28.08.2026): боевые логин и пароль владельца убраны из кода - репозиторий
// публичный. Скрипт берёт их из окружения и без них не запускается:
//   OWNER_LOGIN=<логин> OWNER_PIN=<пароль> node tools/probe-2026-08-16.mjs


const SITE = process.env.SITE_URL || 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const ACC = {
  master: { page: 'crm-master.html', email: env('MASTER_LOGIN'), pin: env('MASTER_PIN') },
  admin: { page: 'crm-admin.html', email: env('ADMIN_LOGIN'), pin: env('ADMIN_PIN') },
  owner: { page: 'crm-owner.html', email: env('OWNER_LOGIN'), pin: OWNER_PIN },
};

const role = process.argv[2] || 'admin';
const section = process.argv[3] || '';
const expr = process.argv[4] || '"нет выражения"';
const acc = ACC[role];

await withBrowser(async (s) => {
  await s.setViewport(1440, 1600, false);
  await s.navigate(`${SITE}/${acc.page}?t=${Date.now()}`);
  for (let i = 0; i < 60; i++) {
    if (await s.eval('!!document.getElementById("loginEmail")')) break;
    await s.sleep(200);
  }
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = ${JSON.stringify(acc.email)};
    document.getElementById('loginPin').value = ${JSON.stringify(acc.pin)};
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  for (let i = 0; i < 60; i++) {
    if (await s.eval('!document.getElementById("crmMain").hidden')) break;
    await s.sleep(250);
  }
  await s.sleep(3000);
  if (section) {
    await s.eval(`(function(){ const b=document.querySelector('.app-nav-item[data-section="${section}"]'); if(b) b.click(); })()`);
    await s.sleep(2500);
  }
  const out = await s.eval(expr, true);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
});
