import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Регрессия 13.08.2026 (живой repro): у сотрудника снят "Принимает клиентов", но
// недельный график остался - POST /bookings отвечал 200 и создавал запись, потому
// что единственная проверка бронируемости смотрела только на график.
test('запись проверяет и график, и приём клиентов - двумя отдельными рубежами', async () => {
  const root = new URL('../', import.meta.url);
  const [bookings, core] = await Promise.all([
    readFile(new URL('api/routes/bookings.js', root), 'utf8'),
    readFile(new URL('api/lib/schedule-core.js', root), 'utf8'),
  ]);
  assert.match(bookings, /mastersWithWorkingSchedule\(client, \[masterId\]\)/);
  assert.match(bookings, /masterAcceptsClients\(client, masterId\)/);
  assert.match(bookings, /reason: 'master_not_accepting'/);
  // причины разные - иначе владелец пойдёт чинить график, который на самом деле цел
  assert.match(bookings, /reason: 'master_not_bookable'/);
  assert.match(core, /provides_services = true/);
});

test('оба контура объясняют отказ человеческим текстом, а не кодом', async () => {
  const root = new URL('../', import.meta.url);
  const [walkin, widget] = await Promise.all([
    readFile(new URL('assets/crm-walkin.js', root), 'utf8'),
    readFile(new URL('app.js', root), 'utf8'),
  ]);
  assert.equal((walkin.match(/master_not_accepting:/g) ?? []).length, 2);
  assert.match(widget, /master_not_accepting: 'Этот мастер сейчас не принимает записи/);
});

test('снятый с приёма сотрудник показывает услуги и график приглушёнными', async () => {
  const root = new URL('../', import.meta.url);
  const [team, css] = await Promise.all([
    readFile(new URL('assets/crm-team.js', root), 'utf8'),
    readFile(new URL('assets/crm-team-content.css', root), 'utf8'),
  ]);
  assert.match(team, /const offDuty = staff\.providesServices === false/);
  assert.match(team, /team-section-offduty/);
  assert.match(team, /снят с приёма клиентов/);
  assert.match(css, /\.team-section-offduty > \*:not\(\.team-section-head\)/);
  // заголовок с причиной не глушим - иначе непонятно, почему блок бледный
  assert.match(css, /\.team-section-offduty \.team-section-head p/);
});

test('смена приёма клиентов перестраивает страницу - календарь собирает состав один раз', async () => {
  const root = new URL('../', import.meta.url);
  const team = await readFile(new URL('assets/crm-team.js', root), 'utf8');
  assert.match(team, /providesServicesChanged/);
  assert.match(team, /window\.location\.reload\(\)/);
});
