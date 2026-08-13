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

test('услуги снятого с приёма не выбираются, график остаётся рабочим', async () => {
  const root = new URL('../', import.meta.url);
  const [team, css] = await Promise.all([
    readFile(new URL('assets/crm-team.js', root), 'utf8'),
    readFile(new URL('assets/crm-team-content.css', root), 'utf8'),
  ]);
  // редактор услуг получает canEdit=false - чекбоксы и длительности отключаются штатно
  assert.match(team, /renderMasterServiceEditor\([\s\S]{0,160}staffCanEdit && staff\.providesServices !== false/);
  // график НЕ зависит от приёма клиентов: у администратора он свой и нужен ему самому
  assert.match(team, /wireWeeklyScheduleEditor\(staff\.id, staffCanEdit, fetchJson\)/);
  assert.doesNotMatch(team, /wireWeeklyScheduleEditor\([^)]*providesServices/);
  // отключённый чекбокс услуги виден неактивным - он нарисован сам, браузер его не гасит
  assert.match(css, /\.service-check:has\(input\[type="checkbox"\]:disabled\)/);
});

test('состояние читается по контролам, без текстовых пояснений в карточке', async () => {
  const root = new URL('../', import.meta.url);
  const [team, css] = await Promise.all([
    readFile(new URL('assets/crm-team.js', root), 'utf8'),
    readFile(new URL('assets/crm-team-content.css', root), 'utf8'),
  ]);
  for (const phrase of ['снят с приёма клиентов', 'Не действует', 'Недоступно:', 'защита от блокировки самого себя']) {
    assert.ok(!team.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n').includes(phrase), `подсказка осталась в интерфейсе: ${phrase}`);
  }
  assert.doesNotMatch(css, /team-section-offduty/);
});

test('смена приёма клиентов перестраивает страницу - календарь собирает состав один раз', async () => {
  const root = new URL('../', import.meta.url);
  const team = await readFile(new URL('assets/crm-team.js', root), 'utf8');
  assert.match(team, /providesServicesChanged/);
  assert.match(team, /window\.location\.reload\(\)/);
});

// Жалоба Влада 13.08.2026: на сайте снятого с приёма нет (бэкенд отбирает только
// оказывающих услуги), а тумблер витрины в карточке стоял включённым и выглядел
// рабочим - обещал то, чего не происходит.
test('тумблер витрины неактивен у снятого с приёма', async () => {
  const root = new URL('../', import.meta.url);
  const team = await readFile(new URL('assets/crm-team.js', root), 'utf8');
  const markup = team.slice(team.indexOf('function mediaMarkup'), team.indexOf('function mediaItem'));
  assert.match(markup, /const offDuty = staff\.providesServices === false/);
  assert.match(markup, /name: 'publicProfileEnabled'[\s\S]*disabled: offDuty/);
});

test('профиль на сайте отбирается по приёму клиентов, а не по одному тумблеру', async () => {
  const root = new URL('../', import.meta.url);
  const route = await readFile(new URL('api/routes/public-masters.js', root), 'utf8');
  assert.match(route, /s\.provides_services=true/);
});

// Живой repro Влада 13.08.2026: услуги снятого с приёма кликались, хотя прогон
// показывал их заблокированными - два рендерера рисуют одни и те же чекбоксы, и
// wireMasterServiceEditors (из renderLiveProof) перерисовывал их зная только роль.
test('оба рендерера услуг учитывают приём клиентов - иначе перерисовка их оживляет', async () => {
  const root = new URL('../', import.meta.url);
  const [team, services] = await Promise.all([
    readFile(new URL('assets/crm-team.js', root), 'utf8'),
    readFile(new URL('assets/crm-master-services.js', root), 'utf8'),
  ]);
  // путь 1 - карточка команды, признак из данных
  assert.match(team, /staffCanEdit && staff\.providesServices !== false/);
  // путь 2 - массовая перерисовка по DOM, признак из карточки
  assert.match(services, /data-provides-services="0"/);
  assert.match(services, /canEdit && !offDuty/);
  // и сам признак действительно попадает в разметку карточки
  assert.match(team, /data-provides-services="\$\{staff\.providesServices \? '1' : '0'\}"/);
});

// Скриншот Влада 13.08.2026: в разделе "Доступ" не подсвечена текущая роль. Радио
// группируются по name в пределах документа, а name был общий - все карточки команды
// и форма добавления оказывались ОДНОЙ группой, отмеченной оставалась одна на странице.
test('у каждой карточки своя группа радиокнопок роли', async () => {
  const root = new URL('../', import.meta.url);
  const team = await readFile(new URL('assets/crm-team.js', root), 'utf8');
  assert.match(team, /rolePicker\(staff\.role, `role-\$\{staff\.id\}`\)/);
  assert.match(team, /rolePicker\('master', 'role-new'\)/);
  // и у rolePicker больше нет общего имени по умолчанию, которое можно случайно получить
  assert.doesNotMatch(team, /function rolePicker\(selectedRole, name = 'role'\)/);
});

test('роль читается внутри своей карточки, а не по общему имени группы', async () => {
  const root = new URL('../', import.meta.url);
  const team = await readFile(new URL('assets/crm-team.js', root), 'utf8');
  assert.doesNotMatch(team, /\[name="role"\]:checked/);
  assert.equal((team.match(/\.team-role-picker input\[type="radio"\]:checked/g) ?? []).length, 2);
});

test('владелец показан подсвеченной карточкой роли, а не строкой текста', async () => {
  const root = new URL('../', import.meta.url);
  const [team, css] = await Promise.all([
    readFile(new URL('assets/crm-team.js', root), 'utf8'),
    readFile(new URL('assets/crm-team-content.css', root), 'utf8'),
  ]);
  assert.match(team, /function roleBadge\(role\)/);
  assert.match(team, /team-role-picker-single/);
  assert.match(team, /<input type="radio" checked disabled>/);
  assert.doesNotMatch(team, /team-role-static/);
  assert.match(css, /\.team-role-picker-single \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  // подсветка выбранного варианта - та же, что у обычных карточек ролей
  assert.match(css, /\.team-role-option input:checked \+ span/);
});

// Живой repro Влада 13.08.2026 под управляющим: галки на месте, а услуги не
// меняются ни у кого. wireMasterServiceEditors осталась с проверкой "только
// владелец" со времён, когда роли управляющего ещё не было.
test('услуги редактирует и управляющий - как разрешает сервер', async () => {
  const root = new URL('../', import.meta.url);
  const [services, server] = await Promise.all([
    readFile(new URL('assets/crm-master-services.js', root), 'utf8'),
    readFile(new URL('api/server.mjs', root), 'utf8'),
  ]);
  assert.match(services, /staffRole === 'owner' \|\| staffRole === 'manager'/);
  // право на сервере - management, то есть owner+manager
  assert.match(server, /path: 'master-services\/:masterId\/:serviceId', auth: 'management'/);
  // но карточку защищённого владельца управляющий по-прежнему не трогает
  assert.match(services, /data-locked-owner/);
});

test('заблокированный тумблер видно - он нарисован вручную и браузером не гасится', async () => {
  const root = new URL('../', import.meta.url);
  const css = await readFile(new URL('assets/crm-team-content.css', root), 'utf8');
  assert.match(css, /\.team-toggle-row:has\(\.switch input:disabled\)/);
  assert.match(css, /\.switch input:disabled ~ \.track/);
  assert.match(css, /\.switch input:disabled \{ cursor: not-allowed; \}/);
});
