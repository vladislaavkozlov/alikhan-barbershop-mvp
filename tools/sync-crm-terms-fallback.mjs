// Пересборка запасных слов во фронте из словаря сервера (Этап B, 24.08.2026).
//
// assets/crm-terms.js держит копию барбершопного словаря - она работает, когда сеть
// легла. Копия, правленная руками, рано или поздно разойдётся с истиной, поэтому её
// не правят, а пересобирают этим скриптом. Расхождение всё равно ловит тест
// (tests/crm-terms.test.js), но чинить его руками незачем.
//
// Запуск: node tools/sync-crm-terms-fallback.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { TERMS, PHRASES } from '../api/lib/vertical-terms.js';
import { MODULE_DEFAULTS } from '../api/lib/vertical-modules.js';

const target = new URL('../assets/crm-terms.js', import.meta.url);
const source = await readFile(target, 'utf8');
const indent = (value) => JSON.stringify(value, null, 2).replace(/\n/g, '\n  ');
const block = `export const FALLBACK = Object.freeze({
  vertical: 'barbershop',
  name: 'барбершоп «Алихан»',
  terms: ${indent(TERMS.barbershop)},
  phrases: ${indent(PHRASES.barbershop)},
  modules: ${indent(MODULE_DEFAULTS.barbershop)},
});`;
const start = source.indexOf('export const FALLBACK = Object.freeze({');
const end = source.indexOf('});', start) + 3;
if (start === -1 || end < start) throw new Error('не нашёл блок запасных слов в assets/crm-terms.js');
await writeFile(target, source.slice(0, start) + block + source.slice(end));
console.log('запасные слова пересобраны из api/lib/vertical-terms.js');
