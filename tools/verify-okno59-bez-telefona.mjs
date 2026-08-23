// Регрессия на жалобу Влада 23.08.2026: у записи БЕЗ телефона клик «Обслужен» давал
// пустоту без единого слова. Теперь на её месте объяснение, а у записи с телефоном
// по-прежнему полный блок срока.
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from '/Users/user/Desktop/barbershop-alikhan-mvp/tools/verify-lib.mjs';
import { withBrowser } from '/Users/user/Desktop/barbershop-alikhan-mvp/tools/cdp.mjs';
const { check, summary } = makeChecker();
const eq = (l, a, e) => check(l, String(a) === String(e), `получено: ${a} · ожидалось: ${e}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withEphemeralServer(async ({ apiUrl, db }) => {
  const pin = randomPin();
  await db.query(`INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
    VALUES ('np-boss',1,'QA Владелец','owner',true,true,true,'np-boss@alikhan.test',$1)`, [hashPin(pin)]);
  await db.query(`INSERT INTO services (id,name,category,price,duration_min) VALUES ('np-cut','Стрижка','base',2000,60) ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO master_services (master_id,service_id,price,duration_min) VALUES ('np-boss','np-cut',2000,60) ON CONFLICT (master_id,service_id) DO UPDATE SET price=2000`);
  for (let w=1;w<=7;w++) await db.query(`INSERT INTO master_weekly_schedule (master_id,weekday,is_working,work_start,work_end) VALUES ('np-boss',$1,true,'10:00','20:00')`,[w]);
  await db.query(`INSERT INTO schedule_shifts (master_id,date,start_time,end_time) VALUES ('np-boss',$1,'10:00','20:00')`,[daysFromToday(0)]);
  await db.query(`INSERT INTO clients (id,name,phone) VALUES ('np-c1','Гость с номером','+79993334455')`);
  // b1 - walk-in без телефона (ровно случай со скриншота), b2 - клиент с номером
  await db.query(`INSERT INTO bookings (id,master_id,location_id,client_id,service_id,date,start_time,end_time,status,walkin_name)
    VALUES ('np-b1','np-boss',1,NULL,'np-cut',$1,'11:00','12:00','planned','Без имени')`,[daysFromToday(0)]);
  await db.query(`INSERT INTO booking_services (booking_id,service_id) VALUES ('np-b1','np-cut')`);
  await db.query(`INSERT INTO bookings (id,master_id,location_id,client_id,service_id,date,start_time,end_time,status)
    VALUES ('np-b2','np-boss',1,'np-c1','np-cut',$1,'13:00','14:00','planned')`,[daysFromToday(0)]);
  await db.query(`INSERT INTO booking_services (booking_id,service_id) VALUES ('np-b2','np-cut')`);

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      await s.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1300, deviceScaleFactor: 1, mobile: false });
      await s.navigate(`${siteUrl}/crm-owner.html`);
      for (let i=0;i<40 && !(await s.eval('!!document.getElementById("loginEmail")'));i++) await sleep(150);
      await s.eval(`(() => { document.getElementById('loginEmail').value='np-boss@alikhan.test';
        document.getElementById('loginPin').value='${pin}';
        document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click(); })()`);
      for (let i=0;i<80 && !(await s.eval('!!document.querySelector("#crmMain:not([hidden])")'));i++) await sleep(200);
      await sleep(1500);

      // Случай со скриншота: запись без телефона
      await s.eval(`[...document.querySelectorAll('.appt')].find((a)=>a.textContent.includes('11:00'))?.click()`);
      await sleep(1200);
      await s.eval(`document.getElementById('st-came')?.click()`);
      await sleep(600);
      eq('без телефона: блока срока нет (правило окна)', await s.eval(`!document.getElementById('wfRenew')?.hidden`), 'false');
      eq('без телефона: объяснение ПОКАЗАНО, а не пустота', await s.eval(`!document.getElementById('wfRenewNoPhone')?.hidden`), 'true');
      const text = await s.eval(`(document.getElementById('wfRenewNoPhone')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0,60)`);
      console.log('   текст:', text);
      eq('кнопка сохранения не заблокирована', await s.eval(`!!document.getElementById('wfSubmit') && document.getElementById('wfSubmit').disabled`), 'false');
      await s.eval(`document.getElementById('wfRenewNoPhone')?.scrollIntoView({block:'center'})`);
      await sleep(400);
      await s.screenshot('/tmp/nophone-obyasnenie.png');

      // Вписали телефон прямо в форме - блок должен появиться
      await s.eval(`(() => { const i = document.getElementById('wfClientPhone');
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        set.call(i,'+7 999 555-66-77'); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(700);
      eq('вписали телефон - блок срока появился', await s.eval(`!document.getElementById('wfRenew')?.hidden`), 'true');
      eq('объяснение при этом убралось', await s.eval(`!document.getElementById('wfRenewNoPhone')?.hidden`), 'false');

      // Запись с телефоном - как было
      await s.eval(`document.getElementById('wfCancel')?.click()`);
      await sleep(500);
      await s.eval(`[...document.querySelectorAll('.appt')].find((a)=>a.textContent.includes('13:00'))?.click()`);
      await sleep(1300);
      await s.eval(`document.getElementById('st-came')?.click()`);
      await sleep(600);
      eq('с телефоном: полный блок срока', await s.eval(`!document.getElementById('wfRenew')?.hidden`), 'true');
      eq('с телефоном: объяснения нет', await s.eval(`!document.getElementById('wfRenewNoPhone')?.hidden`), 'false');
    });
  });
});
summary();
