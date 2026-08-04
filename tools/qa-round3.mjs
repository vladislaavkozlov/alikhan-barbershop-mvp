// QA раунда 3 (28.07.2026): сворачиваемый список "не приходили", крестик по центру,
// скрыть/показать вместо безвозвратного удаления.
import { withBrowser } from './cdp.mjs';

const BASE = 'http://localhost:8793';
const outDir = process.argv[2] || '.';

await withBrowser(async (s) => {
  await s.setViewport(1280, 700, false);
  await s.navigate(`${BASE}/crm-owner.html`);
  await s.sleep(250);

  const isOpenByDefault = await s.eval(`document.querySelector('.retention-alert').open`);
  console.log('retention-alert open by default:', isOpenByDefault);
  await s.screenshot(`${outDir}/retention-collapsed.png`);

  await s.click('.retention-alert summary');
  await s.sleep(200);
  await s.screenshot(`${outDir}/retention-expanded.png`);

  // zoom on one dismiss button to check centering
  const btnBox = await s.eval(`(function(){const b=document.querySelector('.ra-dismiss'); const r=b.getBoundingClientRect(); return JSON.stringify(r);})()`);
  console.log('first ra-dismiss button rect:', btnBox);

  // dismiss first row, check hidden + restore control appears
  const nameBefore = await s.eval(`document.querySelector('.ra-row .ra-name').textContent`);
  await s.click('.ra-dismiss');
  await s.sleep(150);
  const restoreHidden = await s.eval(`document.querySelector('.ra-restore').hidden`);
  const count = await s.eval(`document.querySelector('.ra-restore .count').textContent`);
  console.log('dismissed:', nameBefore, '| restore control hidden:', restoreHidden, '| count:', count);
  await s.screenshot(`${outDir}/retention-after-dismiss.png`);

  // restore it back
  await s.click('.ra-restore button');
  await s.sleep(150);
  const stillThere = await s.eval(`document.querySelector('.ra-row').hidden`);
  console.log('after restore, first row hidden:', stillThere);
  await s.screenshot(`${outDir}/retention-after-restore.png`);
});
