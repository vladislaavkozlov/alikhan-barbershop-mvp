// Дизайн-аудит CRM против нового дизайна сайта (18.08.2026). Не verify-скрипт:
// ничего не проверяет на pass/fail, задача - снять живые экраны трёх кабинетов
// в двух вьюпортах и вытащить фактические токены (палитра, шрифты, радиусы,
// кнопки), чтобы сравнение с лендингом шло по цифрам, а не по впечатлению.
//
// Работает по боевому фронту на GitHub Pages с боевым API: логин + просмотр,
// ни одной записи в данные. Креды берутся ТОЛЬКО из переменных окружения -
// репозиторий публичный, PIN в файлы проекта не кладём (миграция 036).
import { withBrowser } from './cdp.mjs';

const BASE = 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const OUT = process.env.AUDIT_OUT || `${process.env.HOME}/Desktop/crm-audit-2026-08-18`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CABINETS = [
  { page: 'crm-owner.html',  who: 'owner',  email: process.env.CRM_OWNER_EMAIL,  pin: process.env.CRM_OWNER_PIN,
    sections: ['schedule', 'team', 'finance', 'analytics', 'notifications'] },
  { page: 'crm-admin.html',  who: 'admin',  email: process.env.CRM_ADMIN_EMAIL,  pin: process.env.CRM_ADMIN_PIN,
    sections: ['schedule', 'team', 'profile'] },
  { page: 'crm-master.html', who: 'master', email: process.env.CRM_MASTER_EMAIL, pin: process.env.CRM_MASTER_PIN,
    sections: ['today', 'payroll', 'profile'] },
];

async function login(s, page, email, pin) {
  await s.navigate(`${BASE}/${page}?v=${Date.now()}`);
  // Поле появляется раньше, чем crm-auth.js вешает submit-обработчик: клик сразу
  // после появления input уходит в никуда и форма молча остаётся на экране
  for (let i = 0; i < 40; i += 1) {
    if (await s.eval(`!!document.getElementById('loginForm')`) === true) break;
    await sleep(200);
  }
  await sleep(1500);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await s.type('#loginEmail', email);
    await s.type('#loginPin', pin);
    await s.click('#loginForm button[type="submit"]');
    for (let i = 0; i < 30; i += 1) {
      await sleep(300);
      // .login-gate это position:fixed - offsetParent у него null всегда, даже когда
      // он виден на весь экран. Единственная честная проверка - hidden/display
      const st = await s.eval(`(() => {
        const g = document.getElementById('loginGate');
        if (!g) return 'НЕТ_ГЕЙТА';
        if (g.hidden || getComputedStyle(g).display === 'none') return 'ВОШЛИ';
        const e = document.getElementById('loginError');
        return e && !e.hidden && e.textContent.trim() ? 'ОШИБКА: ' + e.textContent.trim() : 'ЖДЁМ';
      })()`);
      if (st === 'ВОШЛИ' || st === 'НЕТ_ГЕЙТА') return true;
      if (st.startsWith('ОШИБКА')) { console.log('   ', st); break; }
    }
    await sleep(800);
  }
  return false;
}

async function goSection(s, section) {
  const r = await s.eval(`(() => {
    if (typeof window.crmGoToSection !== 'function') return 'NO_ROUTER';
    window.crmGoToSection(${JSON.stringify(section)});
    return 'OK';
  })()`);
  await sleep(1600);
  return r;
}

// Фактические значения со страницы - основа для сравнения с лендингом
async function tokens(s) {
  return s.eval(`(() => {
    const cs = getComputedStyle(document.body);
    const root = getComputedStyle(document.documentElement);
    const vars = {};
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules || []) {
        if (r.selectorText === ':root' || r.selectorText === 'html') {
          for (const p of r.style) if (p.startsWith('--')) vars[p] = r.style.getPropertyValue(p).trim();
        }
      }
    }
    const btn = document.querySelector('button:not([hidden])');
    const card = document.querySelector('.staff-card, .card, section');
    const pick = (el, props) => el ? Object.fromEntries(props.map(p => [p, getComputedStyle(el)[p]])) : null;
    return {
      bodyBg: cs.backgroundColor,
      bodyColor: cs.color,
      bodyFont: cs.fontFamily,
      h2Font: (() => { const h = document.querySelector('h1,h2'); return h ? getComputedStyle(h).fontFamily : null; })(),
      vars,
      button: pick(btn, ['backgroundColor','color','borderRadius','minHeight','fontFamily','fontWeight','fontSize']),
      card: pick(card, ['backgroundColor','borderRadius','border','boxShadow']),
      radii: [...new Set([...document.querySelectorAll('*')].slice(0, 700)
        .map(el => getComputedStyle(el).borderRadius).filter(r => r && r !== '0px'))].slice(0, 12),
    };
  })()`);
}

const { mkdir } = await import('node:fs/promises');
await mkdir(OUT, { recursive: true });
const report = {};

await withBrowser(async (s) => {
  for (const cab of CABINETS) {
    if (!cab.email || !cab.pin) { console.log(`пропуск ${cab.who}: нет кред в окружении`); continue; }
    await s.setViewport(1440, 1000, false);
    const ok = await login(s, cab.page, cab.email, cab.pin);
    console.log(`${cab.who}: вход ${ok === true ? 'ок' : 'НЕ УДАЛСЯ'}`);
    if (ok !== true) continue;
    report[cab.who] = await tokens(s);
    for (const sec of cab.sections) {
      const r = await goSection(s, sec);
      if (r !== 'OK') { console.log(`  ${sec}: роутер недоступен`); continue; }
      const active = await s.eval(`document.querySelector('.crm-nav input:checked')?.id ?? document.querySelector('[data-section]:not([hidden])')?.dataset?.section ?? '?'`);
      await s.setViewport(1440, 1000, false); await sleep(500);
      await s.screenshot(`${OUT}/${cab.who}-${sec}--desktop.png`);
      await s.setViewport(390, 844, true); await sleep(900);
      await s.screenshot(`${OUT}/${cab.who}-${sec}--mobile.png`);
      await s.setViewport(1440, 1000, false); await sleep(400);
      console.log(`  снят ${cab.who}/${sec} (активный переключатель: ${active})`);
    }
  }
});

const { writeFile } = await import('node:fs/promises');
await writeFile(`${OUT}/tokens.json`, JSON.stringify(report, null, 2));
console.log(`\nготово: ${OUT}`);
