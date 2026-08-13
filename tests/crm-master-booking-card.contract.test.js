// Кабинет мастера: запись показывается read-only карточкой визита (13.08.2026,
// spec 2026-08-13-master-booking-card.md, вторая итерация по правкам Влада - мастер
// запись не ведёт вообще, всё редактирование у администратора). Два слоя: чистый
// хелпер комиссии (юнит без DOM) и контракт разметки страницы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { masterCommissionLabel } from '../assets/crm-shared.js';

const root = new URL('../', import.meta.url);
const source = (name) => readFile(new URL(name, root), 'utf8');
const rx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

test('masterCommissionLabel: реальная ставка мастера, а не хардкод имён', () => {
  const paid = masterCommissionLabel({ total: 2000, pct: 40, isOwner: false });
  assert.equal(paid.amount, 800);
  assert.match(paid.text, /40%/);
  assert.match(paid.text, /2\s?000/);
});

test('masterCommissionLabel: владелец сам себе комиссию не платит', () => {
  const owner = masterCommissionLabel({ total: 2000, pct: 40, isOwner: true });
  assert.equal(owner.amount, null);
  assert.match(owner.text, /не начисляется/i);
});

test('masterCommissionLabel: нет услуг или нет ставки - честное "нечего считать", не 0 ₽', () => {
  assert.equal(masterCommissionLabel({ total: null, pct: 40, isOwner: false }).amount, null);
  assert.equal(masterCommissionLabel({ total: 2000, pct: null, isOwner: false }).amount, null);
});

test('crm-master.html: старая карточка #bd-1 и её бутафория удалены', async () => {
  const html = await source('crm-master.html');
  assert.doesNotMatch(html, /id="bd-1"/);
  for (const dead of [
    'id="bconfirm"',            // роута на client_confirmed нет нигде
    'id="bk-noshow-btn"',       // статус "не пришёл" ставит администратор, не мастер
    'id="bk-comment-thread"',   // addComment() рисовал в DOM и никуда не сохранял
    'birthday-banner',          // "день рождения 15 августа" - литерал в разметке
    'Клиент с нами с',
    'id="bkServiceEditPicker"',
  ]) {
    assert.doesNotMatch(html, rx(dead), `осталось: ${dead}`);
  }
});

test('crm-master.html: карточка визита только на просмотр, ни одного контрола', async () => {
  const html = await source('crm-master.html');
  for (const alive of ['id="masterBookingView"', 'id="mbWhen"', 'id="mbClient"', 'id="mbStatus"',
    'id="mbServices"', 'id="mbTotal"', 'id="mbCommission"']) {
    assert.match(html, rx(alive), `нет: ${alive}`);
  }
  // Формы записи у мастера нет вовсе - ни её самой, ни любого её контрола
  for (const forbidden of ['id="walkinForm"', 'id="wfServicePicker"', 'id="wfSubmit"', 'id="wfCancel"',
    'id="wfMasterRow"', 'id="wfDateTimeRow"', 'id="wfEditExtras"', 'id="wfDangerZone"', 'id="bkDeleteRow"',
    'id="bkActualPrice"', 'id="bkStaffComment"', 'name="bstatus"', 'id="bk-status-note"']) {
    assert.doesNotMatch(html, rx(forbidden), `лишнее: ${forbidden}`);
  }
  // Телефон клиента и подпись про скрытый номер убраны совсем (правка Влада)
  assert.doesNotMatch(html, /wfClientPhone|phone-hidden|скрыто - доступно только/);
  // Подпись про отметку услуг тоже убрана - отмечать нечего
  assert.doesNotMatch(html, /Отмеченные услуги уже записаны/);
});

test('crm-master.html: карточка визита обёрнута в тот же details, что День/Неделя/Месяц', async () => {
  const html = await source('crm-master.html');
  // Отступ между карточками и сворачивание даёт общий компонент панелей, а не свои стили
  assert.match(html, /upgradeMasterBookingPanel/);
  const js = await source('assets/crm-navigation-panels.js');
  assert.match(js, /export function upgradeMasterBookingPanel/);
  assert.match(js, /details\.className = 'staff-card schedule-view-card booking-view-card'/);
});

test('crm-owner.html / crm-admin.html: их форма записи не задета', async () => {
  for (const page of ['crm-owner.html', 'crm-admin.html']) {
    const html = await source(page);
    assert.match(html, /id="walkinForm"/, page);
    assert.doesNotMatch(html, /id="masterBookingView"/, page);
    for (const owned of ['id="wfMasterRow"', 'id="wfDateTimeRow"', 'id="wfEditExtras"', 'id="bkActualPrice"',
      'id="wfSubmit"', 'name="bstatus"']) {
      assert.match(html, rx(owned), `${page}: пропал ${owned}`);
    }
  }
});

test('crm-master-booking.js: только чтение - ни одного запроса на изменение', async () => {
  const js = await source('assets/crm-master-booking.js');
  assert.doesNotMatch(js, /method:\s*'(POST|PATCH|PUT|DELETE)'/);
  assert.doesNotMatch(js, /fetch\(/);
  // Точка входа та же, что у общей формы - её зовёт календарь (buildApptCard)
  assert.match(js, /window\.openBookingEdit/);
  // Комиссия считается от фактической суммы, когда администратор её уже провёл
  assert.match(js, /actualPrice/);
});

test('crm-walkin.js: ролевых веток кабинета мастера в форме записи не осталось', async () => {
  const js = await source('assets/crm-walkin.js');
  assert.doesNotMatch(js, /masterView|bookingView/);
  // Но защита от свёртки в услугу, которой нет в прайсе мастера, остаётся - это общий фикс
  assert.match(js, /mergeCombosFor/);
});
