// Служебное: печатает те самые строки, которые считает сито №1 - список работ для
// фаз 3-5. Правило счёта общее, лежит в tools/vertical-leftovers-core.mjs.
// Запуск: node tools/list-vertical-leftovers.mjs <файл> [ещё файл...]
import { readFile } from 'node:fs/promises';
import { leftoverLines } from './vertical-leftovers-core.mjs';
for (const file of process.argv.slice(2)) {
  const source = await readFile(new URL(file, new URL('../', import.meta.url)), 'utf8');
  const found = leftoverLines(source);
  console.log(`\n=== ${file}: ${found.length} ===`);
  for (const { line, text } of found) console.log(`${line}: ${text}`);
}
