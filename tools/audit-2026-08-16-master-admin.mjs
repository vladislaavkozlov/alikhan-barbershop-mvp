// Аудит кабинетов МАСТЕРА и АДМИНИСТРАТОРА перед сдачей проекта (16.08.2026).
// Гоняется по ЖИВОМУ проду (GitHub Pages + Amvera) под боевыми логинами:
//   мастер        - логин из MASTER_LOGIN (Елизавета, role=master)
//   администратор - логин из ADMIN_LOGIN (role=admin)
// master-2 (Мамедхан) больше не master, а manager - он работает на странице владельца,
// поэтому для роли "мастер" берём master-3.
//
// Что собирает: ошибки консоли, unhandled rejection, все НЕуспешные fetch-ответы,
// состояние разделов (пусто/заполнено), скриншоты 1280 и 390 по каждому разделу.
// Ничего не меняет в данных - только читает и переключает вкладки.
import { withBrowser } from './cdp.mjs';
import { mkdirSync } from 'node:fs';

// Окно 72 (28.08.2026): боевые логины и пароли убраны из кода - репозиторий публичный,
// а до этой правки пароли всех пятерых сотрудников салона лежали здесь открытым
// текстом. Скрипт берёт доступы из окружения, например:
//   OWNER_LOGIN=aliovsad OWNER_PIN=<пароль> node tools/audit-2026-08-16-master-admin.mjs
const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задан доступ ${name}. Пример: ${name}=<значение> node tools/audit-2026-08-16-master-admin.mjs`);
    process.exit(1);
  }
  return value;
};


const SITE = process.env.SITE_URL || 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const OUT = '/tmp/audit-crm-2026-08-16';
mkdirSync(OUT, { recursive: true });

const ACCOUNTS = {
  master: { page: 'crm-master.html', email: env('MASTER_LOGIN'), pin: env('MASTER_PIN'), sections: ['today', 'payroll', 'profile'] },
  admin: { page: 'crm-admin.html', email: env('ADMIN_LOGIN'), pin: env('ADMIN_PIN'), sections: ['schedule', 'team', 'profile'] },
};

const INSTRUMENT = `
  window.__errors = [];
  window.__net = [];
  const _ce = console.error;
  console.error = function (...a) { try { window.__errors.push('console.error: ' + a.map(x => (x && x.message) ? x.message : String(x)).join(' ')); } catch {} return _ce.apply(console, a); };
  window.addEventListener('error', (e) => window.__errors.push('onerror: ' + (e.message || '')));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));
  const _f = window.fetch;
  window.fetch = async function (...a) {
    const url = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url) || '';
    const method = (a[1] && a[1].method) || (a[0] && a[0].method) || 'GET';
    try {
      const r = await _f.apply(window, a);
      if (!r.ok) window.__net.push(r.status + ' ' + method + ' ' + url);
      return r;
    } catch (err) {
      window.__net.push('FAILED ' + method + ' ' + url + ' :: ' + (err && err.message));
      throw err;
    }
  };
`;

async function run(role) {
  const acc = ACCOUNTS[role];
  const report = { role, errors: [], net: [], sections: {} };

  await withBrowser(async (s) => {
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    await s.setViewport(1280, 1400, false);
    await s.navigate(`${SITE}/${acc.page}?t=${Date.now()}`);

    // Форму входа рисует crm-auth.js, а не HTML - ждём появления поля циклом
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

    report.loggedIn = await s.eval('!document.getElementById("crmMain").hidden');
    report.topbarName = await s.eval(`(document.getElementById('selfNameBadge')||{}).textContent || null`);
    report.sidebarProfile = await s.eval(`(document.getElementById('appShellProfile')||{}).textContent || null`);
    report.navItems = await s.eval(`JSON.stringify([...document.querySelectorAll('.app-nav-item')].map(b => b.dataset.section + ':' + b.querySelector('.app-nav-label').textContent.trim()))`);

    for (const section of acc.sections) {
      await s.eval(`(function(){ const b=document.querySelector('.app-nav-item[data-section="${section}"]'); if(b) b.click(); })()`);
      await s.sleep(2500);
      const info = await s.eval(`(function(){
        const panel = document.querySelector('.seg-panel:not([hidden])') || document.body;
        const active = [...document.querySelectorAll('.app-nav-item')].find(b => b.getAttribute('aria-current') === 'true');
        const vis = [...document.querySelectorAll('main .card, main section')].filter(e => e.offsetParent !== null).length;
        const txt = (document.querySelector('main') || document.body).innerText;
        return JSON.stringify({
          active: active ? active.dataset.section : null,
          visibleBlocks: vis,
          textLen: txt.length,
          suspicious: [...new Set((txt.match(/(не удалось[^\\n]{0,60}|ошибка[^\\n]{0,60}|Сессия закончилась|undefined|NaN|00%|000 ₽|пример|скоро|в разработке|заглушка)/gi) || []))],
          emptyButtons: [...document.querySelectorAll('main button')].filter(b => b.offsetParent !== null && !b.textContent.trim() && !b.querySelector('svg') && !b.getAttribute('aria-label')).length
        });
      })()`);
      report.sections[section] = JSON.parse(info);
      await s.setViewport(1280, 1400, false);
      await s.sleep(300);
      await s.screenshot(`${OUT}/${role}-${section}-1280.png`);
      await s.setViewport(390, 844, true);
      await s.sleep(800);
      await s.screenshot(`${OUT}/${role}-${section}-390.png`);
      await s.setViewport(1280, 1400, false);
      await s.sleep(500);
    }

    report.errors = JSON.parse(await s.eval('JSON.stringify(window.__errors)'));
    report.net = JSON.parse(await s.eval('JSON.stringify(window.__net)'));
  });

  return report;
}

const role = process.argv[2] || 'master';
const rep = await run(role);
console.log(JSON.stringify(rep, null, 2));
