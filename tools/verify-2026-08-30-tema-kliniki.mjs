// Проверка темы «Клиника» (30.08.2026): собственный вид кабинета клиники и
// доказательство, что кабинет барбершопа при этом не тронут.
//
// Главный вопрос владельца звучал как «чтобы редизайн не повлиял на Алихана».
// Проверяется он не рассуждением «правила же с атрибутом», а тремя фактами:
// сервер отдаёт барбершопу тему `default`; в файле темы нет НИ ОДНОГО правила без
// атрибута [data-theme="clinic"]; ни один другой файл стилей на этот атрибут не
// смотрит. Плюс замер контраста - палитра сайта в кабинете применима не целиком.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appearanceFor, themeFor } from '../api/lib/vertical-terms.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const css = read('assets/crm-theme-clinic.css');
const ok = [];
const fail = [];
const check = (name, fn) => {
  try {
    fn();
    ok.push(name);
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail.push(name);
    console.log(`  ❌ ${name}\n     ${e.message.split('\n')[0]}`);
  }
};

console.log('\n── Сервер: тема приходит от вертикали ─────────────────────────');
check('барбершоп получает тему default', () => {
  assert.equal(themeFor('barbershop'), 'default');
  assert.equal(appearanceFor('barbershop').theme, 'default');
});
check('клиника получает тему clinic', () => {
  assert.equal(appearanceFor('clinic').theme, 'clinic');
});
check('неизвестная вертикаль откатывается на default', () => {
  assert.equal(themeFor('нечто'), 'default');
  assert.equal(themeFor(undefined), 'default');
  assert.equal(themeFor(null), 'default');
});
check('словарь вертикали от правки не пострадал', () => {
  assert.equal(appearanceFor('clinic').terms.master.nom, 'врач');
  assert.equal(appearanceFor('barbershop').terms.master.nom, 'мастер');
});

console.log('\n── Изоляция: файл темы не может задеть барбершоп ──────────────');
// Разбор простой и намеренно строгий: берём всё, что стоит перед «{», отбрасываем
// комментарии и @-правила, и требуем атрибут в КАЖДОМ селекторе. Строгость здесь
// важнее гибкости - забытый атрибут означает поехавший кабинет у платящего клиента
// @-правила (@import со списком весов шрифта, @media) режутся ДО разбора: внутри
// @import живут и свои запятые, и свои точки с запятой (веса Cormorant записаны
// как «wght@0,300;0,400»), поэтому строка режется до конца строки, а не до «;»
const body = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^\n]*/g, '');
const selectors = [];
for (const block of body.split('}')) {
  const head = block.split('{')[0].trim();
  if (!head || block.indexOf('{') === -1) continue;
  const cleaned = head.replace(/@media[^{]*/g, '').trim();
  if (!cleaned) continue;
  for (const sel of cleaned.split(',')) {
    const s = sel.trim();
    if (!s || s.startsWith('@')) continue;
    selectors.push(s);
  }
}
check(`каждое правило темы висит на атрибуте (селекторов: ${selectors.length})`, () => {
  const naked = selectors.filter((s) => !s.includes('[data-theme="clinic"]'));
  assert.deepEqual(naked, [], `правила без атрибута: ${naked.join(' | ')}`);
});
check('в теме нет !important, кроме вуали шторки', () => {
  const lines = body.split('\n').filter((l) => l.includes('!important'));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0].includes('app-drawer-scrim'));
});
check('на атрибут data-theme не смотрит ни один чужой файл стилей', () => {
  for (const f of ['assets/mockup-crm.css', 'assets/crm-theme-daylight.css', 'assets/crm-app-shell.css']) {
    assert.ok(!read(f).includes('data-theme'), `${f} трогает тему`);
  }
});
check('следов барбершопа в теме клиники нет', () => {
  // Ищем в коде, а не в комментариях: и герб, и фото интерьера в комментариях
  // названы намеренно - там объяснено, почему они здесь снимаются
  for (const trace of ['crest-hero', 'interior-honeycomb', 'wordmark', 'Алихан', 'Playfair']) {
    assert.ok(!body.includes(trace), `в теме остался след: ${trace}`);
  }
});
check('фото интерьера барбершопа и герб перекрыты явно', () => {
  // Оба приёма приходят из светлой темы. Тема клиники обязана переопределить
  // именно те селекторы, где они заданы, иначе картинки останутся
  assert.ok(css.includes('.login-gate'), 'экран входа не перекрыт - останется фото барбершопа');
  assert.ok(css.includes('body.app-shell-active #crmMain'), 'рабочая область не перекрыта - останется герб');
});

console.log('\n── Разметка кабинетов ─────────────────────────────────────────');
for (const f of ['crm-owner.html', 'crm-admin.html', 'crm-master.html']) {
  const html = read(f);
  check(`${f}: тема подключена после «Дневного света»`, () => {
    const day = html.indexOf('crm-theme-daylight.css');
    const clinic = html.indexOf('crm-theme-clinic.css');
    assert.ok(day !== -1 && clinic !== -1, 'не подключена');
    assert.ok(clinic > day, 'тема стоит раньше светлой - её перекроют');
  });
  check(`${f}: атрибут ставится из кэша до отрисовки`, () => {
    assert.ok(html.includes("localStorage.getItem('crm.theme')"), 'нет скрипта - будет вспышка чужой палитры');
    assert.ok(html.indexOf("crm.theme") < html.indexOf('<body'), 'скрипт стоит после <body>');
  });
}

console.log('\n── Фронт: чужое значение темы в разметку не попадёт ────────────');
const terms = read('assets/crm-terms.js');
check('имя темы проверяется регуляркой перед подстановкой', () => {
  assert.ok(terms.includes('/^[a-z0-9-]{1,32}$/'), 'нет проверки имени темы');
  assert.ok(terms.includes("theme: 'default'"), 'нет запасного значения темы');
});
check('падение localStorage не роняет кабинет', () => {
  const at = terms.indexOf('export function applyTheme');
  assert.ok(at !== -1);
  assert.ok(terms.slice(at, at + 700).includes('catch'), 'нет защиты приватного режима');
});

console.log('\n── Контраст палитры сайта в кабинете ──────────────────────────');
const lum = (hex) => {
  const [r, g, b] = hex.match(/\w\w/g).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const pairs = [
  ['чернила на полотне', '#1E1C1A', '#EFE8DE', 4.5],
  ['чернила на карточке', '#1E1C1A', '#FCFAF6', 4.5],
  ['приглушённый текст на полотне', '#6E665C', '#EFE8DE', 4.5],
  ['приглушённый текст на карточке', '#6E665C', '#FCFAF6', 4.5],
  ['шампань-текст на полотне', '#7C5E33', '#EFE8DE', 4.5],
  ['шампань-текст на карточке', '#7C5E33', '#FCFAF6', 4.5],
  ['шампань на тонированной подложке', '#6E522B', '#E7DED2', 4.5],
  ['молоко на графите хрома', '#F7F3ED', '#1E1C1A', 4.5],
  ['приглушённый текст хрома', '#9A9186', '#1E1C1A', 4.5],
  ['шампань хрома', '#B2915F', '#1E1C1A', 4.5],
  ['текст на шампанской заливке', '#1E1C1A', '#A9884F', 4.5],
];
for (const [name, fg, bg, min] of pairs) {
  const r = ratio(fg, bg);
  check(`${name}: ${r.toFixed(2)}:1 (нужно ${min})`, () => assert.ok(r >= min, `${r.toFixed(2)} < ${min}`));
}
check('сайтовая шампань в мелкий текст на молоке не попала', () => {
  // Она читается 2.4:1 - именно поэтому в токенах стоит углублённая ступень
  assert.ok(ratio('#B2915F', '#EFE8DE') < 4.5);
  assert.ok(!/--accent:\s*#B2915F/.test(css.split('.app-sidebar')[0]), 'сайтовая шампань попала в основной --accent');
});

console.log(`\nИтог: ${ok.length} прошло, ${fail.length} провалено`);
process.exit(fail.length ? 1 : 0);
