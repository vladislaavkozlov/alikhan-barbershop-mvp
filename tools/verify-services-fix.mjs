// Проверка правки 28.07.2026: полный список услуг (8) у каждого мастера, длительность-плейсхолдер,
// заглушка формулы ЗП, read-only чекбоксы услуг в admin.html.
import { withBrowser } from './cdp.mjs';

const BASE = 'http://localhost:8793';
const outDir = process.argv[2] || '/tmp';

await withBrowser(async (s) => {
  await s.setViewport(1280, 1400, false);
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.click('label[for="pt-b"]');
  await s.sleep(150);

  const ownerCounts = await s.eval(`(function(){
    const cards = document.querySelectorAll('.staff-card');
    return JSON.stringify(Array.from(cards).map(c => ({
      name: c.querySelector('.name').textContent.trim(),
      services: c.querySelectorAll('.service-picker .service-check').length,
      durations: Array.from(c.querySelectorAll('.service-picker .sc-price')).filter(p => p.textContent.includes('время уточняется')).length
    })));
  })()`);
  console.log('owner.html Сотрудники - услуг на карточку:', ownerCounts);

  const formulaBlock = await s.eval(`document.body.textContent.includes('Формула расчёта зарплаты') && document.body.textContent.includes('конструктор формулы расчёта зарплаты')`);
  console.log('owner.html - заглушка формулы ЗП есть:', formulaBlock);

  const h1 = await s.eval('document.documentElement.scrollHeight');
  await s.setViewport(1280, Math.min(h1, 4200), false);
  await s.screenshot(`${outDir}/v-owner-staff.png`);

  await s.navigate(`${BASE}/crm-admin.html`);
  await s.sleep(200);
  await s.click('label[for="pt-b"]');
  await s.sleep(150);

  const adminCounts = await s.eval(`(function(){
    const cards = document.querySelectorAll('.staff-card');
    return JSON.stringify(Array.from(cards).map(c => {
      const boxes = c.querySelectorAll('.service-picker .service-check input');
      return {
        name: c.querySelector('.name').textContent.trim(),
        services: c.querySelectorAll('.service-picker .service-check').length,
        allDisabled: boxes.length > 0 && Array.from(boxes).every(b => b.disabled)
      };
    }));
  })()`);
  console.log('admin.html Сотрудники - услуг на карточку + read-only:', adminCounts);

  const h2 = await s.eval('document.documentElement.scrollHeight');
  await s.setViewport(1280, Math.min(h2, 4200), false);
  await s.screenshot(`${outDir}/v-admin-staff.png`);
});
