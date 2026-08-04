// Скриншоты 3 макетов Окна 9 (mockup-owner/admin/master) для визуальной проверки.
// Использование: python3 -m http.server 8793 (в этой папке), затем node tools/shot-mockups.mjs [outDir]
import { withBrowser } from './cdp.mjs';

const BASE = 'http://localhost:8793';
const outDir = process.argv[2] || '.';
const targets = [
  { file: 'mockup-owner', tab: null },
  { file: 'mockup-owner', tab: '#pt-b', suffix: '-staff' },
  { file: 'mockup-admin', tab: null },
  { file: 'mockup-admin', tab: '#pt-b', suffix: '-staff' },
  { file: 'mockup-master', tab: null },
];

await withBrowser(async (s) => {
  for (const t of targets) {
    await s.setViewport(1280, 900, false);
    await s.navigate(`${BASE}/${t.file}.html`);
    await s.sleep(250);
    if (t.tab) { await s.click(t.tab); await s.sleep(150); }
    const h = await s.eval('document.documentElement.scrollHeight');
    await s.setViewport(1280, Math.min(h, 20000), false);
    await s.sleep(150);
    const name = `${t.file}${t.suffix || ''}`;
    await s.screenshot(`${outDir}/${name}.png`);
    console.log(name, 'height=', h);
  }
});
