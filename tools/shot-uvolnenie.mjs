// Скриншоты окна «Увольнение» для показа Владу
import { withEphemeralServer, withStaticServer, hashPin, randomPin } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function todayLocal(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
const TODAY = todayLocal();
await withEphemeralServer(async ({ apiUrl, db }) => {
  const pin = randomPin();
  await db.query(`INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES ('sh-boss',1,'QA Управляющий','manager',true,true,true,'sh-boss@alikhan.test',$1)`,[hashPin(pin)]);
  await db.query(`INSERT INTO staff (id, location_id, name, role, employed, employment_ended_at, provides_services, has_system_access, email) VALUES ('sh-fired',1,'Руслан Ушедший','master',false,DATE '2026-06-15',true,true,'sh-fired@alikhan.test')`);
  await db.query(`INSERT INTO master_services (master_id, service_id, price, duration_min) SELECT 'sh-fired', id, price, duration_min FROM services`);
  await db.query(`INSERT INTO master_payroll_settings (master_id, pct) VALUES ('sh-fired', 50) ON CONFLICT (master_id) DO UPDATE SET pct = 50`);
  for (const [id,st,en] of [['sh-b1','11:00','11:40'],['sh-b2','12:00','12:40']]) {
    await db.query(`INSERT INTO bookings (id,location_id,master_id,client_id,date,start_time,end_time,status,channel,walkin_name) VALUES ($1,1,'sh-fired',NULL,$2,$3,$4,'done','walkin','Клиент')`,[id,TODAY,st,en]);
    await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ($1,'strizhka')`,[id]);
  }
  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      await s.navigate(`${siteUrl}/crm-owner.html`);
      for (let i=0;i<40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")'));i++) await sleep(150);
      await s.eval(`(function(){document.getElementById('loginEmail').value='sh-boss@alikhan.test';document.getElementById('loginPin').value='${pin}';document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();})()`);
      for (let i=0;i<60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")'));i++) await sleep(200);

      await s.eval(`document.querySelector('#pt-b, [for="pt-b"]')?.click()`);
      for (let i=0;i<80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.panel-b .team-fired-group'))`));i++) await sleep(200);
      await s.eval(`document.querySelector('.panel-b .team-fired-toggle')?.setAttribute('open','')`);
      await s.eval(`document.querySelector('.panel-b .team-fired-group')?.scrollIntoView({block:'center'})`);
      await sleep(600);
      await s.screenshot('/tmp/uvolnenie-1-blok.png');

      // карточка работающего с кнопкой «Уволить» + подтверждение
      await s.eval(`document.querySelector('.panel-b .team-editor-card[data-staff-id="master-2"]')?.setAttribute('open','')`);
      await sleep(800);
      await s.eval(`document.querySelector('.team-editor-card[data-staff-id="master-2"] [data-fire]')?.click()`);
      await sleep(400);
      await s.eval(`document.querySelector('.team-editor-card[data-staff-id="master-2"] [data-employment-actions]')?.scrollIntoView({block:'center'})`);
      await sleep(400);
      await s.screenshot('/tmp/uvolnenie-2-podtverzhdenie.png');

      // финансы: карточка уволенного с деньгами
      await s.eval(`document.querySelector('#pt-c, [for="pt-c"]')?.click()`);
      for (let i=0;i<80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#payrollStaffList .payroll-card[data-master-id="sh-fired"]'))`));i++) await sleep(200);
      for (let i=0;i<80 && JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.panel-c .unsure'))`));i++) await sleep(200);
      // Блок «Зарплаты мастеров» - свёрнутая навигационная панель, раскрываем как человек
      await s.eval(`[...document.querySelectorAll('.panel-c .crm-nav-panel, .panel-c details, .panel-c .nav-panel')].forEach((p) => p.setAttribute('open',''))`);
      await sleep(600);
      await s.eval(`document.querySelector('#payrollStaffList .payroll-card[data-master-id="sh-fired"]')?.setAttribute('open','')`);
      await sleep(400);
      await s.eval(`document.querySelector('#payrollStaffList .payroll-card[data-master-id="sh-fired"] summary')?.scrollIntoView({block:'start'})`);
      await s.eval(`document.querySelector('#payrollStaffList .payroll-card[data-master-id="sh-fired"]')?.scrollIntoView({block:'center'})`);
      await sleep(700);
      await s.screenshot('/tmp/uvolnenie-3-finansy.png');
    });
  });
});
console.log('готово');
