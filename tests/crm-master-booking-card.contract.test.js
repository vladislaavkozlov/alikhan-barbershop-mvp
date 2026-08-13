// Карточка записи в кабинете мастера переведена с макета #bd-1 на общую форму
// #walkinForm (13.08.2026, spec 2026-08-13-master-booking-card.md). Здесь два слоя:
// чистые хелперы (addedServiceIds/masterCommissionLabel - юниты без DOM) и контракт
// разметки crm-master.html (тот же приём, что в crm-team-render.contract.test.js:
// читаем файл и проверяем, что декоративные блоки ушли, а рабочие пришли).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { addedServiceIds, masterCommissionLabel } from '../assets/crm-shared.js';

const root = new URL('../', import.meta.url);

test('addedServiceIds: мастер может только ДОПИСАТЬ услугу, снятие не уезжает на сервер', () => {
  // PATCH /bookings/:id/services умеет только добавление (handleBookingAddServices) -
  // снятая галочка не должна превращаться в запрос, который ничего не сделает.
  assert.deepEqual(addedServiceIds(['s1'], ['s1', 's2']), ['s2']);
  assert.deepEqual(addedServiceIds(['s1', 's2'], ['s1']), []);
  assert.deepEqual(addedServiceIds([], ['s1']), ['s1']);
  assert.deepEqual(addedServiceIds(['s1'], ['s1']), []);
  assert.deepEqual(addedServiceIds(undefined, undefined), []);
  // Дубликаты в выборе не должны уехать дважды
  assert.deepEqual(addedServiceIds(['s1'], ['s2', 's2']), ['s2']);
});

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
  const html = await readFile(new URL('crm-master.html', root), 'utf8');
  assert.doesNotMatch(html, /id="bd-1"/);
  // Ни одного контрола, который ничего не сохраняет, и ни одного выдуманного клиента
  for (const dead of [
    'id="bconfirm"',            // роута на client_confirmed нет нигде
    'id="bk-noshow-btn"',       // второй контрол того же статуса рядом с радио
    'id="bk-comment-thread"',   // addComment() рисует в DOM и никуда не сохраняет
    'birthday-banner',          // "день рождения 15 августа" - литерал в разметке
    'Клиент с нами с',
    'id="bkServiceEditPicker"', // отдельный второй список услуг - его заменил общий
  ]) {
    assert.doesNotMatch(html, new RegExp(dead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `осталось: ${dead}`);
  }
});

test('crm-master.html: общая форма записи в режиме мастера, только разрешённые контролы', async () => {
  const html = await readFile(new URL('crm-master.html', root), 'utf8');
  assert.match(html, /id="walkinForm"/);
  assert.match(html, /data-booking-view="master"/);
  // Рабочие блоки
  for (const alive of ['id="wfServicePicker"', 'id="wfSummary"', 'id="wfSubmit"', 'id="wfCancel"',
    'id="wfResult"', 'id="bk-status-note"', 'name="bstatus"', 'id="wfBookingWhen"', 'id="wfCommission"']) {
    assert.match(html, new RegExp(alive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `нет: ${alive}`);
  }
  // Запрещённое мастеру бэкендом не должно существовать в его DOM вообще
  for (const forbidden of ['id="wfMasterRow"', 'id="wfDateTimeRow"', 'id="wfEditExtras"',
    'id="wfDangerZone"', 'id="bkDeleteRow"', 'id="bkActualPrice"', 'id="bkStaffComment"']) {
    assert.doesNotMatch(html, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `лишнее: ${forbidden}`);
  }
});

test('crm-owner.html / crm-admin.html: их форма записи не задета', async () => {
  for (const page of ['crm-owner.html', 'crm-admin.html']) {
    const html = await readFile(new URL(page, root), 'utf8');
    assert.match(html, /id="walkinForm"/, page);
    assert.doesNotMatch(html, /data-booking-view="master"/, page);
    for (const owned of ['id="wfMasterRow"', 'id="wfDateTimeRow"', 'id="wfEditExtras"', 'id="bkActualPrice"']) {
      assert.match(html, new RegExp(owned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${page}: пропал ${owned}`);
    }
  }
});

test('crm-walkin.js: режим мастера шлёт PATCH услуг и не зовёт reschedule', async () => {
  const js = await readFile(new URL('assets/crm-walkin.js', root), 'utf8');
  assert.match(js, /bookingView/);
  assert.match(js, /addedServiceIds/);
  // Перенос остаётся у owner/admin - но под явным запретом для режима мастера
  assert.match(js, /masterView[\s\S]{0,400}reschedule|reschedule[\s\S]{0,400}masterView/);
});
