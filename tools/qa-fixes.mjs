// Точечная QA-проверка правок 28.07.2026: подсветка календаря на клик, "Задать период",
// право на выплаты ЗП, карточка Мамеда. Разовый скрипт, не входит в постоянный набор.
import { withBrowser } from './cdp.mjs';

const BASE = 'http://localhost:8793';
const outDir = process.argv[2] || '.';

await withBrowser(async (s) => {
  await s.setViewport(1280, 1400, false);
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(250);

  // 1) подсветка календаря: кликаем по записи Мамеда 10:00-10:30, затем по записи Али 14:30-15:00
  const clickRes1 = await s.click('[data-client="Клиент Д (пример)"]');
  await s.sleep(150);
  const afterFirstClick = await s.eval(`Array.from(document.querySelectorAll('.appt--selected .c')).map(e=>e.textContent).join('|')`);
  console.log('click result:', clickRes1, '| selected after click on Клиент Д (Мамед 10:00) →', afterFirstClick);

  const clickRes2 = await s.click('[data-client="Клиент В (пример)"]');
  await s.sleep(150);
  const afterSecondClick = await s.eval(`Array.from(document.querySelectorAll('.appt--selected .c')).map(e=>e.textContent).join('|')`);
  console.log('click result:', clickRes2, '| selected after click on Клиент В (Али 14:30) →', afterSecondClick);
  await s.setViewport(1280, 1300, false);
  await s.screenshot(`${outDir}/calendar-selection.png`);

  // 2) "Задать период" + "Выплаты ЗП" на карточке Али
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.click('#pt-b');
  await s.sleep(150);
  await s.click('label[for="zp1p-period"]');
  await s.sleep(100);
  const h1 = await s.eval(`document.querySelector('.panel-zp1p-period').getBoundingClientRect().top + window.scrollY`);
  await s.eval(`window.scrollTo(0, ${h1} - 60)`);
  await s.sleep(100);
  await s.screenshot(`${outDir}/zp-period-before.png`);
  await s.type('.panel-zp1p-period .field:nth-child(1) input[type="date"]', '2026-07-01');
  await s.type('.panel-zp1p-period .field:nth-child(2) input[type="date"]', '2026-07-15');
  await s.click('.panel-zp1p-period button');
  await s.sleep(100);
  await s.screenshot(`${outDir}/zp-period-after.png`);
  const periodNote = await s.eval(`document.querySelector('.panel-zp1p-period .payroll-note').textContent`);
  console.log('period note after fill →', periodNote);

  await s.click('label[for="zp1-pay"]');
  await s.sleep(100);
  const h2 = await s.eval(`document.querySelector('.panel-zp1-pay').getBoundingClientRect().top + window.scrollY`);
  await s.eval(`window.scrollTo(0, ${h2} - 60)`);
  await s.sleep(100);
  await s.screenshot(`${outDir}/zp-payouts-owner.png`);

  // 3) карточка Мамеда - право на выплаты ЗП
  await s.click('.staff-list details:nth-of-type(2) summary');
  await s.sleep(150);
  const h3 = await s.eval(`document.querySelector('.staff-list details:nth-of-type(2)').getBoundingClientRect().top + window.scrollY`);
  await s.eval(`window.scrollTo(0, ${h3} - 40)`);
  await s.sleep(100);
  await s.setViewport(1280, 900, false);
  await s.screenshot(`${outDir}/mamed-permission-toggle.png`);
  const toggleText = await s.eval(`document.querySelector('.staff-list details:nth-of-type(2) .tr-label').textContent`);
  console.log('mamed toggle label →', toggleText);

  // 4) admin.html - заблокированная вкладка "Выплаты ЗП"
  await s.navigate(`${BASE}/crm-admin.html`);
  await s.sleep(200);
  await s.click('#pt-b');
  await s.sleep(150);
  await s.click('label[for="zp1-pay"]');
  await s.sleep(100);
  const h4 = await s.eval(`document.querySelector('.panel-zp1-pay').getBoundingClientRect().top + window.scrollY`);
  await s.eval(`window.scrollTo(0, ${h4} - 60)`);
  await s.sleep(100);
  await s.screenshot(`${outDir}/admin-zp-payouts-locked.png`);
});
