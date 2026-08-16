// Скриншоты кабинетов с РАСКРЫТЫМИ панелями (иначе виден только список свёрнутых
// карточек). Прод, боевые логины. Запуск: node tools/shots-2026-08-16.mjs <role>
import { withBrowser } from './cdp.mjs';
import { mkdirSync } from 'node:fs';

const SITE = process.env.SITE_URL || 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const OUT = '/tmp/audit-crm-2026-08-16';
mkdirSync(OUT, { recursive: true });

const ACC = {
  master: { page: 'crm-master.html', email: 'master3-test@alikhan.test', pin: '0708', sections: ['today', 'payroll', 'profile'] },
  admin: { page: 'crm-admin.html', email: 'master4-test@alikhan.test', pin: '517563', sections: ['schedule', 'team', 'profile'] },
  owner: { page: 'crm-owner.html', email: 'master1-test@alikhan.test', pin: '4495', sections: ['schedule', 'team'] },
};

const role = process.argv[2] || 'master';
const only = process.argv[3];
const acc = ACC[role];

await withBrowser(async (s) => {
  await s.setViewport(1440, 2400, false);
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
  await s.sleep(3500);

  for (const section of acc.sections) {
    if (only && section !== only) continue;
    await s.eval(`(function(){ const b=document.querySelector('.app-nav-item[data-section="${section}"]'); if(b) b.click(); })()`);
    await s.sleep(2000);
    await s.eval(`(function(){ document.querySelectorAll('.tab-panel:not([hidden]) details.staff-card, main details.staff-card').forEach(d => d.setAttribute('open','')); })()`);
    await s.sleep(2500);
    const h = await s.eval(`Math.min(6000, Math.max(1200, document.documentElement.scrollHeight))`);
    await s.setViewport(1440, h, false);
    await s.sleep(1200);
    await s.screenshot(`${OUT}/${role}-${section}-open.png`);
    await s.setViewport(390, 2600, true);
    await s.sleep(1500);
    await s.screenshot(`${OUT}/${role}-${section}-open-390.png`);
    await s.setViewport(1440, 2400, false);
    await s.sleep(500);
    console.log(`сняты ${role}/${section} (высота ${h})`);
  }
});
