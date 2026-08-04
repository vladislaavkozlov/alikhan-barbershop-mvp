// QA раунда 4 (28.07.2026): колокольчик в шапке вместо блока "не приходили" на первом экране.
import { withBrowser } from './cdp.mjs';

const BASE = 'http://localhost:8793';
const outDir = process.argv[2] || '.';

await withBrowser(async (s) => {
  await s.setViewport(1280, 800, false);
  for (const file of ['mockup-owner', 'mockup-admin', 'mockup-master']) {
    await s.navigate(`${BASE}/${file}.html`);
    await s.sleep(250);
    const panelVisible = await s.eval(`getComputedStyle(document.getElementById('retention-panel')).display`);
    console.log(file, 'panel display before click:', panelVisible);
    await s.screenshot(`${outDir}/${file}-landing.png`);

    await s.click('.notif-bell');
    await s.sleep(200);
    const panelVisibleAfter = await s.eval(`getComputedStyle(document.getElementById('retention-panel')).display`);
    console.log(file, 'panel display after bell click:', panelVisibleAfter);
    await s.screenshot(`${outDir}/${file}-panel-open.png`);

    await s.click('.ra-close');
    await s.sleep(150);
    const panelAfterClose = await s.eval(`getComputedStyle(document.getElementById('retention-panel')).display`);
    console.log(file, 'panel display after close:', panelAfterClose);
  }

  // dismiss updates the bell badge count
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(200);
  await s.click('.notif-bell');
  await s.sleep(150);
  const badgeBefore = await s.eval(`document.querySelector('.notif-badge').textContent`);
  await s.click('.ra-dismiss');
  await s.sleep(150);
  const badgeAfter = await s.eval(`document.querySelector('.notif-badge').textContent`);
  console.log('badge before/after dismiss:', badgeBefore, badgeAfter);
  await s.screenshot(`${outDir}/badge-after-dismiss.png`);
});
