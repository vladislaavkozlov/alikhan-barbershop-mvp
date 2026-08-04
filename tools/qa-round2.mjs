// QA раунда 2 (28.07.2026): заголовок карточки записи, "Все точки" в Выручке,
// dismiss в retention-списке. Разовый скрипт.
import { withBrowser } from './cdp.mjs';

const BASE = 'http://localhost:8793';
const outDir = process.argv[2] || '.';

await withBrowser(async (s) => {
  await s.setViewport(1280, 900, false);

  // 1) заголовок карточки записи обновляется по клику
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(250);
  const before = await s.eval(`document.getElementById('bd-now').textContent`);
  console.log('summary before click:', before);
  await s.click('[data-client="Клиент В (пример)"]');
  await s.sleep(150);
  const after = await s.eval(`document.getElementById('bd-now').textContent`);
  console.log('summary after click on Клиент В:', after);
  const h1 = await s.eval(`document.querySelector('.booking-detail').getBoundingClientRect().top + window.scrollY`);
  await s.eval(`window.scrollTo({top: ${h1} - 40, behavior:'instant'})`);
  await s.sleep(100);
  await s.screenshot(`${outDir}/booking-summary.png`);

  // 2) "Все точки" в Выручке
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.click('#pt-c');
  await s.sleep(150);
  await s.screenshot(`${outDir}/revenue-all-locations.png`);
  const allLabel = await s.eval(`document.querySelector('.seg-bar label[for="rv-loc-all"]').textContent`);
  console.log('rv-loc-all label:', allLabel);
  await s.click('label[for="rv-loc1"]');
  await s.sleep(100);
  const p1visible = await s.eval(`getComputedStyle(document.querySelector('.panel-rv-loc1')).display`);
  console.log('panel-rv-loc1 display after clicking Точка 1:', p1visible);

  // 3) dismiss в retention-списке
  await s.navigate(`${BASE}/crm-admin.html`);
  await s.sleep(200);
  const countBefore = await s.eval(`document.querySelectorAll('.ra-row').length`);
  await s.click('.ra-row .ra-dismiss');
  await s.sleep(150);
  const countAfter = await s.eval(`document.querySelectorAll('.ra-row').length`);
  console.log('retention rows before/after dismiss:', countBefore, countAfter);
  await s.screenshot(`${outDir}/retention-dismiss.png`);
});
