// Живой прогон темы «Дневной свет» (19.08.2026): проверяет, что после
// переворота палитры в светлую сторону в рабочей области не осталось (1) тёмных
// пятен от старой темы и (2) текста ниже порога читаемости WCAG AA
// (4.5:1 мелкий, 3:1 крупный/полужирный от 18.66px).
//
// Почему прогон идёт по ПРОДУ, а не по локальному серверу: боевой API не
// принимает запросы с origin localhost - вход просто не проходит («Нет связи с
// сервером»). Поэтому скрипт открывает боевую страницу с реальными данными и
// подмешивает в неё ЛОКАЛЬНЫЙ assets/crm-theme-daylight.css отдельным <style>.
// Прод при этом не меняется: правка живёт только во вкладке браузера.
// Ничего не сохраняет и не отправляет - только читает и считает цвета.
//
// Запуск: node tools/verify-daylight-theme.mjs [owner|admin|master]
import { withBrowser } from './cdp.mjs';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../assets/crm-theme-daylight.css', import.meta.url), 'utf8')
  .replace(/url\("brand\//g,'url("assets/brand/').replace(/url\("interior-honeycomb/g,'url("assets/interior-honeycomb');
const SITE='https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
// Логины НЕ лежат в файле: каталог tools/ уезжает в публичный репозиторий
// (git ls-files tools/ - 120 файлов в открытом доступе). Пара email+PIN
// передаётся окружением на один запуск:
//   CRM_EMAIL=... CRM_PIN=... node tools/verify-daylight-theme.mjs owner
const ACC={owner:{p:'crm-owner.html',s:['schedule','team','finance','analytics','notifications']},
           admin:{p:'crm-admin.html',s:['schedule','team','profile']},
           master:{p:'crm-master.html',s:['today','payroll','profile']}};
const role=process.argv[2]||'owner'; const a=ACC[role];
a.e = process.env.CRM_EMAIL; a.pin = process.env.CRM_PIN;
if(!a.e || !a.pin){
  console.error('Нужны CRM_EMAIL и CRM_PIN в окружении - в файле логинов нет намеренно.');
  process.exit(2);
}

const AUDIT = `(function(){
  const lum = (r,g,b)=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
  const parse = c => { const s=String(c); const m=s.match(/[\\d.]+/g); if(!m) return null; let [r,g,b,al]=m.map(Number);
    if(/^color\\(/.test(s)){ r*=255; g*=255; b*=255; }
    return {r,g,b,a: al===undefined?1:al}; };
  const bgOf = el => { let n=el; while(n && n!==document.documentElement){ const c=parse(getComputedStyle(n).backgroundColor); if(c && c.a>0.55) return c; n=n.parentElement; } return {r:234,g:229,b:217,a:1}; };
  const ratio=(a,b)=>{const l1=lum(a.r,a.g,a.b),l2=lum(b.r,b.g,b.b);const hi=Math.max(l1,l2),lo=Math.min(l1,l2);return (hi+0.05)/(lo+0.05)};
  const inChrome = el => !!el.closest('.app-sidebar, header.site, .login-gate, .login-card, .app-drawer, .msg-panel');
  // Плашки-бейджи залиты цветом статуса намеренно (латунь/зелёный/красный) -
  // это не «остаток тёмной темы», а смысловая метка. Из поиска пятен исключаем.
  const isFilledBadge = el => el.classList.contains('badge') || !!el.closest('.badge');
  const sel = el => el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\\s+/).slice(0,3).join('.'):'');
  const dark=[], low=[];
  const seenD=new Set(), seenL=new Set();
  document.querySelectorAll('main *, #crmMain *').forEach(el=>{
    const r=el.getBoundingClientRect(); if(r.width<8||r.height<8) return;
    const cs=getComputedStyle(el); if(cs.visibility==='hidden'||cs.display==='none'||el.closest('[hidden]')) return;
    if(inChrome(el)) return;
    const own=parse(cs.backgroundColor);
    if(own && own.a>0.6 && lum(own.r,own.g,own.b)<0.16 && r.width*r.height>2500 && !isFilledBadge(el)){ const k=sel(el); if(!seenD.has(k)){seenD.add(k); dark.push({sel:k, bg:cs.backgroundColor, area:Math.round(r.width*r.height)});} }
    const txt=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim().length>1);
    if(txt){
      const fg=parse(cs.color); if(!fg||fg.a<0.5) return;
      const bg=bgOf(el); const cr=ratio(fg,bg);
      const size=parseFloat(cs.fontSize), bold=parseInt(cs.fontWeight,10)>=600;
      const need=(size>=24||(size>=18.66&&bold))?3:4.5;
      if(cr<need){ const k=sel(el); if(!seenL.has(k)){seenL.add(k); low.push({sel:k, color:cs.color, on:'rgb('+bg.r+','+bg.g+','+bg.b+')', ratio:Math.round(cr*100)/100, need, size, text:(el.textContent||'').trim().slice(0,34)});} }
    }
  });
  return JSON.stringify({dark, low});
})()`;

await withBrowser(async (s) => {
  await s.setViewport(1440, 2000, false);
  await s.navigate(`${SITE}/${a.p}?t=${Date.now()}`);
  for(let i=0;i<60;i++){if(await s.eval('!!document.getElementById("loginEmail")'))break;await s.sleep(200);}
  const inject=`(function(){var o=document.getElementById('daylight');if(o)o.remove();var t=document.createElement('style');t.id='daylight';t.textContent=${JSON.stringify(css)};document.head.appendChild(t);return 1})()`;
  await s.eval(inject);
  await s.eval(`(function(){document.getElementById('loginEmail').value=${JSON.stringify(a.e)};document.getElementById('loginPin').value=${JSON.stringify(a.pin)};document.getElementById('loginForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));})()`);
  for(let i=0;i<80;i++){if(await s.eval('!document.getElementById("crmMain").hidden'))break;await s.sleep(250);}
  await s.sleep(3500); await s.eval(inject);
  const all={dark:{},low:{}};
  for(const sec of a.s){
    const ok=await s.eval(`(function(){const b=document.querySelector('.app-nav-item[data-section="${sec}"]');if(!b)return 0;b.click();return 1})()`);
    if(!ok){console.log('нет раздела',sec);continue;}
    await s.sleep(2200);
    await s.eval(`(function(){document.querySelectorAll('details.staff-card').forEach(d=>d.setAttribute('open',''))})()`);
    await s.sleep(2500);
    const r=JSON.parse(await s.eval(AUDIT));
    r.dark.forEach(d=>{all.dark[d.sel]=d}); r.low.forEach(l=>{all.low[l.sel]=l});
    console.log(`${role}/${sec}: тёмных пятен ${r.dark.length}, низкий контраст ${r.low.length}`);
  }
  console.log('\n=== ТЁМНЫЕ ПЯТНА ===');
  Object.values(all.dark).forEach(d=>console.log(' ', d.sel, d.bg, d.area+'px²'));
  console.log('=== НИЗКИЙ КОНТРАСТ ===');
  Object.values(all.low).sort((x,y)=>x.ratio-y.ratio).forEach(l=>console.log(` ${l.ratio}:1 (надо ${l.need}) ${l.sel} ${l.color} на ${l.on} · "${l.text}"`));
});
