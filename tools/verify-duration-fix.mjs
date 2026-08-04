// Проверка правки 28.07.2026 (раунд 2): overlap на "Выручка", реальная длительность
// услуги по мастеру (редактируемая у владельца), живая связь Сотрудники -> запись.
import { withBrowser } from './cdp.mjs';

const BASE = 'http://localhost:8793';
const outDir = process.argv[2] || '/tmp';

await withBrowser(async (s) => {
  // 1) owner.html - вкладка Выручка, проверка отсутствия overlap + скрин
  await s.setViewport(1280, 1200, false);
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.click('label[for="pt-c"]');
  await s.sleep(150);
  const gap = await s.eval(`(function(){
    const bar = document.querySelector('.panel-rv-loc-all').closest('.seg-tabs').querySelector('.seg-bar');
    const hint = document.querySelector('.panel-rv-loc-all .section-hint');
    const r1 = bar.getBoundingClientRect(), r2 = hint.getBoundingClientRect();
    return JSON.stringify({ bar_bottom: r1.bottom, hint_top: r2.top, gap: r2.top - r1.bottom });
  })()`);
  console.log('owner.html Выручка - зазор между кнопками и текстом (gap>0 значит не накладываются):', gap);
  const h0 = await s.eval('document.documentElement.scrollHeight');
  await s.setViewport(1280, Math.min(h0, 1400), false);
  await s.screenshot(`${outDir}/v2-owner-revenue.png`);

  // 2) owner.html - Сотрудники: реальные дефолтные длительности + правка Стрижки Али на 55
  await s.setViewport(1280, 1400, false);
  await s.click('label[for="pt-b"]');
  await s.sleep(150);
  const defaults = await s.eval(`(function(){
    const inputs = document.querySelectorAll('.staff-card:nth-of-type(1) .sc-duration-input');
    return JSON.stringify(Array.from(inputs).map(i => i.dataset.svc + '=' + i.value));
  })()`);
  console.log('owner.html - дефолтные длительности у Али:', defaults);

  await s.eval(`(function(){
    const input = document.querySelector('.staff-card:nth-of-type(1) .sc-duration-input[data-svc="Стрижка"]');
    input.value = '55';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await s.sleep(100);

  // 3) открыть Расписание, кликнуть запись Клиент А (Стрижка, Али) - проверить что длительность сразу 55
  await s.click('label[for="pt-a"]');
  await s.sleep(150);
  const afterClick = await s.eval(`(function(){
    const appt = document.querySelector('.appt[data-client="Клиент А (пример)"]');
    appt.click();
    return document.getElementById('bk-duration').value;
  })()`);
  console.log('owner.html - длительность записи Клиент А после правки Стрижки Али на 55:', afterClick);

  // 4) переключить услугу в "Изменить услугу" на Борода - длительность должна стать 30 (дефолт)
  const afterSwitch = await s.eval(`(function(){
    document.querySelector('.service-edit .service-check input[type=checkbox]:nth-of-type(1)');
    const boxes = document.querySelectorAll('.service-edit .service-check input[type=checkbox]');
    boxes[0].checked = false;
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event('click', { bubbles: true }));
    return document.getElementById('bk-duration').value;
  })()`);
  console.log('owner.html - длительность после переключения на Бороду в "Изменить услугу":', afterSwitch);

  const h2 = await s.eval('document.documentElement.scrollHeight');
  await s.setViewport(1280, Math.min(h2, 1700), false);
  await s.screenshot(`${outDir}/v2-owner-staff-duration.png`);

  // 5) admin.html и master.html - дефолтные значения читаются верно
  await s.navigate(`${BASE}/crm-admin.html`);
  await s.sleep(200);
  const adminDefault = await s.eval(`document.getElementById('bk-duration').value`);
  console.log('admin.html - дефолтная длительность открытой записи (Комплекс, Али):', adminDefault);

  await s.navigate(`${BASE}/crm-master.html`);
  await s.sleep(200);
  const masterDefault = await s.eval(`document.getElementById('bk-duration').value`);
  console.log('master.html - дефолтная длительность открытой записи (Стрижка, Али):', masterDefault);
});
