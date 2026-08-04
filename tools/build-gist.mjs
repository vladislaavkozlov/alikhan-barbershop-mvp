// Сборка самодостаточных gist-*.html из crm-*.html + assets/mockup-crm.css/js
// и публикация в существующий gist Влада (id ниже). Нужно запускать ПОСЛЕ каждой
// правки crm-owner.html/crm-admin.html/crm-master.html или assets/ - иначе
// Влад по своей ссылке видит старую версию (правка 28.07.2026: он два раза подряд не
// видел свежих фиксов, потому что этот шаг забыли сделать - см. memory
// reference_barbershop-gist-deploy.md).
//
// Использование: node tools/build-gist.mjs [--publish]
// Без --publish только собирает файлы в /tmp/gist-*.html, ничего не публикует.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = '/Users/user/Desktop/barbershop-alikhan-mvp';
const css = readFileSync(`${ROOT}/assets/mockup-crm.css`, 'utf8');
const js = readFileSync(`${ROOT}/assets/mockup-crm.js`, 'utf8');

const GIST_ID = '2aa0cf71c6e5686e84f1504afd4972c1';
const RAW_BASE = `https://gist.githubusercontent.com/vladislaavkozlov/${GIST_ID}/raw`;
const VERSION = String(Date.now());
const wrap = (file) => `https://htmlpreview.github.io/?${RAW_BASE}/${file}?v=${VERSION}`;

const pages = [
  { src: 'crm-owner.html', out: 'gist-owner.html' },
  { src: 'crm-admin.html', out: 'gist-admin.html' },
  { src: 'crm-master.html', out: 'gist-master.html' },
];

for (const { src, out } of pages) {
  let html = readFileSync(`${ROOT}/${src}`, 'utf8');
  html = html.replace(
    '<link rel="stylesheet" href="assets/mockup-crm.css" />',
    `<style>\n${css}</style>`
  );
  html = html.replace(
    '<script src="assets/mockup-crm.js"></script>',
    `<script>\n${js}</script>`
  );
  // Переключатель роли (шапка) - в гисте плоские файлы без "mockup-*.html", и без
  // обёртки htmlpreview.github.io браузер отдаёт raw HTML как текст, не рендерит.
  // Переписываем на полные htmlpreview-ссылки на файлы-соседи по этому же гисту.
  html = html
    .replace('href="crm-owner.html"', `href="${wrap('gist-owner.html')}"`)
    .replace('href="crm-admin.html"', `href="${wrap('gist-admin.html')}"`)
    .replace('href="crm-master.html"', `href="${wrap('gist-master.html')}"`);
  writeFileSync(`/tmp/${out}`, html);
  console.log(`built /tmp/${out} (${html.length} bytes)`);
}

if (process.argv.includes('--publish')) {
  for (const { out } of pages) {
    execSync(`gh gist edit ${GIST_ID} --filename ${out} /tmp/${out}`, { stdio: 'inherit' });
  }
  console.log('\nСсылки (версия ' + VERSION + '):');
  for (const { out } of pages) {
    console.log(wrap(out));
  }
}
