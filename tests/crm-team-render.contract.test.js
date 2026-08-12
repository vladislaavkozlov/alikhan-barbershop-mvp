import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const root = new URL('../', import.meta.url);
test('команда строится из API плоскими секциями и завершается добавлением сотрудника', async () => {
  const js = await readFile(new URL('assets/crm-team.js', root), 'utf8');
  for (const label of ['Основное','Профиль на сайте','Услуги и время','График','Доступ']) assert.match(js, new RegExp(label));
  assert.match(js, /fetchJson\('\/staff'\)/);
  assert.match(js, /addCard\(locations\)/);
  assert.match(js, /renderMasterServiceEditor/);
  assert.match(js, /wireWeeklyScheduleEditor/);
  assert.match(js, /data-schedule-exception/);
  assert.match(js, /\/schedule\?masterId/);
  assert.match(js, /\/schedule-exceptions/);
  assert.match(js, /data-media-list/);
  assert.match(js, /media\/order/);
  assert.match(js, /data-role/);
  assert.match(js, /locationId/);
  assert.match(js, /crm:authenticated/);
  for (const icon of ['ICON_PROFILE', 'ICON_SERVICES', 'ICON_SCHEDULE', 'ICON_ACCESS', 'ICON_UPLOAD']) {
    assert.match(js, new RegExp(icon));
  }
  assert.match(js, /class="switch"/);
  assert.match(js, /team-file-action/);
  assert.match(js, /team-role-option/);
  assert.match(js, /openStaffIds/);
  assert.doesNotMatch(js, /<input name="(?:employed|providesServices|publicProfileEnabled|hasSystemAccess)" type="checkbox"/);
  assert.doesNotMatch(js, /beforeAfterUrls/);
});

test('стили команды отменяют вложенные карточки, системные галочки и держат 360 px', async () => {
  const css = await readFile(new URL('assets/crm-team-content.css', root), 'utf8');
  assert.match(css, /\.team-editor-section\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.service-check input\[type="checkbox"\]\s*\{[^}]*appearance:\s*none/s);
  assert.match(css, /\.team-file-native\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /@media \(max-width:\s*640px\)/);
  assert.match(css, /grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /min-width:\s*0/);
});
