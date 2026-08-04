// Самопроверка правок Влада 27.07.2026 (второй раунд фидбека): роли-чекбоксы, отступы вкладки
// Неделя, комиссия+смена услуги, кнопка "Клиент пришёл", высота календаря "Мой день".
import { withBrowser } from './cdp.mjs';

const BASE = 'http://localhost:8793';
const outDir = process.argv[2] || '/tmp';

await withBrowser(async (s) => {
  // 1) owner.html - вкладка Неделя, проверка отступов + скрин
  await s.setViewport(1280, 1000, false);
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.click('label[for="sp-week"]');
  await s.sleep(150);
  const gap = await s.eval(`(function(){
    const seg = document.querySelector('.panel-sp-week .seg-bar');
    const hint = document.querySelector('.panel-sp-week .section-hint');
    const msr = document.querySelector('.panel-sp-week .master-switch-row .seg-bar');
    const r1 = seg.getBoundingClientRect(), r2 = hint.getBoundingClientRect(), r3 = msr.getBoundingClientRect();
    return JSON.stringify({ seg_bottom: r1.bottom, hint_top: r2.top, hint_bottom: r2.bottom, msr_top: r3.top });
  })()`);
  console.log('owner week gaps:', gap);
  const h1 = await s.eval('document.documentElement.scrollHeight');
  await s.setViewport(1280, Math.min(h1, 4000), false);
  await s.screenshot(`${outDir}/v-owner-week.png`);

  // 2) owner.html - роли-чекбоксы: проверить что можно отметить несколько одновременно
  await s.setViewport(1280, 1400, false);
  await s.click('label[for="pt-b"]');
  await s.sleep(150);
  const roleCheck = await s.eval(`(function(){
    const boxes = document.querySelectorAll('.staff-card:nth-of-type(1) .role-picker input[type=checkbox]');
    return JSON.stringify(Array.from(boxes).map(b => b.checked));
  })()`);
  console.log('owner role checkboxes (Али, до клика):', roleCheck);
  await s.click('.staff-card:nth-of-type(1) .role-picker .role-option:nth-of-type(2) input');
  await s.sleep(100);
  const roleCheck2 = await s.eval(`(function(){
    const boxes = document.querySelectorAll('.staff-card:nth-of-type(1) .role-picker input[type=checkbox]');
    return JSON.stringify(Array.from(boxes).map(b => b.checked));
  })()`);
  console.log('owner role checkboxes (после клика на Администратор):', roleCheck2);

  // 3) owner.html - кнопка "Клиент пришёл"
  await s.click('label[for="pt-a"]');
  await s.sleep(150);
  const before = await s.eval(`document.getElementById('bk-actual').value`);
  await s.eval(`document.getElementById('bk-actual').value = ''`);
  const arrivalBtnExists = await s.eval(`!!document.querySelector('.arrival-row button')`);
  console.log('arrival button exists:', arrivalBtnExists, 'before:', before);
  await s.click('.arrival-row button');
  await s.sleep(100);
  const after = await s.eval(`document.getElementById('bk-actual').value`);
  const statusAfter = await s.eval(`document.getElementById('st-came').checked`);
  console.log('bk-actual after markArrived click:', after, 'st-came checked:', statusAfter);

  // 4) owner.html - смена услуги (details) существует и содержит чекбоксы
  const svcEdit = await s.eval(`(function(){
    const d = document.querySelector('.service-edit');
    if (!d) return 'MISSING';
    return JSON.stringify({ count: d.querySelectorAll('.service-check').length, commissionField: !!document.querySelector('.commission-note') });
  })()`);
  console.log('service-edit block:', svcEdit);

  // 5) master.html - высота "Мой день" (без клиппинга) + скрин
  await s.setViewport(1280, 1000, false);
  await s.navigate(`${BASE}/crm-master.html`);
  await s.sleep(200);
  const trackInfo = await s.eval(`(function(){
    const tr = document.querySelector('.panel-sp-day .schedule-track');
    const cs = getComputedStyle(tr);
    return JSON.stringify({ overflow: cs.overflow, minHeight: cs.minHeight, actualHeight: tr.getBoundingClientRect().height });
  })()`);
  console.log('master day track:', trackInfo);
  const h2 = await s.eval('document.documentElement.scrollHeight');
  await s.setViewport(1280, Math.min(h2, 3500), false);
  await s.screenshot(`${outDir}/v-master-day.png`);

  // 6) проверка переименования во всех 3 файлах
  for (const file of ['mockup-owner', 'mockup-admin', 'mockup-master']) {
    await s.navigate(`${BASE}/${file}.html`);
    await s.sleep(150);
    const names = await s.eval(`JSON.stringify({ hasIvan1: document.body.textContent.includes('Иван 1'), hasIvan2: document.body.textContent.includes('Иван 2'), hasAli: document.body.textContent.includes('Али'), hasMamed: document.body.textContent.includes('Мамед') })`);
    console.log(file, 'renaming check:', names);
  }

  // 7) admin.html booking card - комиссия + arrival button присутствуют
  await s.navigate(`${BASE}/crm-admin.html`);
  await s.sleep(150);
  const adminCheck = await s.eval(`JSON.stringify({ arrival: !!document.querySelector('.arrival-row button'), commission: !!document.querySelector('.commission-note'), serviceEdit: !!document.querySelector('.service-edit') })`);
  console.log('admin booking card extras:', adminCheck);
});
