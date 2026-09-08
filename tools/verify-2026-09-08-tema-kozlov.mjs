// Живой прогон фирменной темы KOZLOV (08.09.2026). Проверяет в НАСТОЯЩЕМ браузере
// то, что нельзя проверить чтением CSS: какие значения реально доехали до экрана
// после всех слоёв каскада и не осталось ли текста ниже порога читаемости.
//
// Почему прогон идёт по ПЕСОЧНИЦЕ, а не по проду: тема ещё не задеплоена, а
// песочница отдаёт ровно локальные файлы (tools/pesochnica.mjs). Боевой API при
// этом настоящий - арендатор «Песочница (демо)», своих данных, чужих не видит.
//
// Запуск (в соседнем окне терминала должна работать песочница):
//   node tools/pesochnica.mjs
//   CRM_EMAIL=demo CRM_PIN=246810 node tools/verify-2026-09-08-tema-kozlov.mjs
//
// Что проверяется:
//   1. знак продукта стоит в меню и на экране входа;
//   2. хром действительно графитовый, а полотно бумажное (значения бренда);
//   3. заголовок раздела появляется и меняется при переходе;
//   4. «Финансы» открываются с раскрытым первым блоком, а не оглавлением;
//   5. плавающая кнопка «Развернуть все» больше не висит над содержимым;
//   6. ни одного текстового узла ниже WCAG AA во всех семи разделах владельца.
import { withBrowser } from './cdp.mjs';

const BASE = process.env.CRM_BASE ?? 'http://localhost:8793';
const EMAIL = process.env.CRM_EMAIL;
const PIN = process.env.CRM_PIN;
if (!EMAIL || !PIN) {
  console.error('Нужны CRM_EMAIL и CRM_PIN в окружении - в файле логинов нет намеренно.');
  process.exit(2);
}

// Тот же счёт контраста, что в tools/verify-daylight-theme.mjs. Формат color(srgb …)
// обязателен к разбору отдельно: числа там 0..1, и без множителя 255 светлый фон
// принимается за чёрный, а каждая подпись на нём - за нечитаемую (поймано на этом
// же прогоне: одиннадцать ложных находок в «Команде»).
const AUDIT = `(function(){
  const lum=(r,g,b)=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
  const parse=c=>{const s=String(c);const m=s.match(/[\\d.]+/g);if(!m)return null;let[r,g,b,a]=m.map(Number);
    if(/^color\\(/.test(s)){r*=255;g*=255;b*=255;}
    return {r,g,b,a:a===undefined?1:a};};
  const bgOf=el=>{let n=el;while(n&&n!==document.documentElement){const c=parse(getComputedStyle(n).backgroundColor);if(c&&c.a>0.55)return c;n=n.parentElement;}return {r:239,g:233,b:220,a:1};};
  const ratio=(a,b)=>{const l1=lum(a.r,a.g,a.b),l2=lum(b.r,b.g,b.b);const hi=Math.max(l1,l2),lo=Math.min(l1,l2);return (hi+0.05)/(lo+0.05)};
  const sel=el=>el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\\s+/).slice(0,2).join('.'):'');
  const low=[],seen=new Set();
  document.querySelectorAll('body *').forEach(el=>{
    const r=el.getBoundingClientRect(); if(r.width<8||r.height<8) return;
    const cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none'||el.closest('[hidden]')) return;
    if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim().length>1)) return;
    const fg=parse(cs.color); if(!fg||fg.a<0.5) return;
    const cr=ratio(fg,bgOf(el));
    const size=parseFloat(cs.fontSize), bold=parseInt(cs.fontWeight,10)>=600;
    const need=(size>=24||(size>=18.66&&bold))?3:4.5;
    if(cr<need){const k=sel(el); if(!seen.has(k)){seen.add(k); low.push(k+' '+Math.round(cr*100)/100+' («'+el.textContent.trim().slice(0,24)+'»)');}}
  });
  return JSON.stringify(low);
})()`;

const problems = [];
const ok = (name) => console.log('  ✔', name);
const fail = (name, got) => { problems.push(`${name} - ${got}`); console.log('  ✖', name, '→', got); };

await withBrowser(async (s) => {
  console.log('Вход');
  await s.navigate(`${BASE}/crm-owner.html`);
  await new Promise((r) => setTimeout(r, 1200));

  const loginBrand = await s.eval(`!!document.querySelector('.login-brand .kz-k')`);
  loginBrand ? ok('знак продукта на экране входа') : fail('знак продукта на экране входа', 'нет узла .login-brand');
  const loginCardBg = await s.eval(`getComputedStyle(document.querySelector('.login-card')).backgroundColor`);
  /253, 250, 243/.test(loginCardBg) ? ok('карточка входа бумажная') : fail('карточка входа бумажная', loginCardBg);

  await s.type('#loginEmail', EMAIL);
  await s.type('#loginPin', PIN);
  await s.click('.login-card button[type="submit"]');
  await new Promise((r) => setTimeout(r, 3500));

  console.log('Оболочка');
  const sidebarBrand = await s.eval(`document.querySelector('.app-sidebar-brand')?.textContent.trim() ?? ''`);
  sidebarBrand.includes('KOZLOV') ? ok('знак продукта в меню') : fail('знак продукта в меню', sidebarBrand || 'пусто');

  const sidebarBg = await s.eval(`getComputedStyle(document.querySelector('.app-sidebar')).backgroundColor`);
  /21, 23, 22/.test(sidebarBg) ? ok('меню графитовое') : fail('меню графитовое', sidebarBg);

  const canvasBg = await s.eval(`getComputedStyle(document.documentElement).backgroundColor`);
  /239, 233, 220/.test(canvasBg) ? ok('полотно бумажное') : fail('полотно бумажное', canvasBg);

  const serif = await s.eval(`getComputedStyle(document.querySelector('.crm-section-title')).fontFamily`);
  /Literata/.test(serif) ? ok('заголовок раздела засечный') : fail('заголовок раздела засечный', serif);

  const toggleFixed = await s.eval(`getComputedStyle(document.querySelector('.panel-group-controls')).position`);
  toggleFixed === 'static' ? ok('кнопка «Развернуть все» в потоке') : fail('кнопка «Развернуть все» в потоке', toggleFixed);

  console.log('Разделы');
  const sections = ['schedule', 'team', 'services', 'clients', 'finance', 'analytics', 'notifications'];
  for (const id of sections) {
    await s.eval(`document.querySelector('[data-section="${id}"]').click()`);
    await new Promise((r) => setTimeout(r, 1800));
    const title = await s.eval(`document.querySelector('.crm-section-title')?.textContent ?? ''`);
    title ? ok(`${id}: заголовок «${title}»`) : fail(`${id}: заголовок раздела`, 'пусто');
    if (id === 'finance' || id === 'analytics') {
      const opened = await s.eval(`[...document.querySelectorAll('.tab-panel')].find(p=>p.offsetParent!==null)?.querySelector('details.staff-card')?.open === true`);
      opened ? ok(`${id}: первый блок раскрыт`) : fail(`${id}: первый блок раскрыт`, 'закрыт');
    }
    await s.eval(`document.querySelectorAll('details.staff-card').forEach(d=>{ if(d.offsetParent) d.open = true; })`);
    await new Promise((r) => setTimeout(r, 900));
    const low = JSON.parse(await s.eval(AUDIT));
    low.length === 0 ? ok(`${id}: контраст всех подписей выше порога`) : fail(`${id}: контраст`, low.join(' | '));
  }
});

console.log('');
if (problems.length) {
  console.log(`ИТОГ: ${problems.length} расхождений`);
  problems.forEach((p) => console.log(' -', p));
  process.exit(1);
}
console.log('ИТОГ: тема на месте, контраст в норме во всех разделах');
