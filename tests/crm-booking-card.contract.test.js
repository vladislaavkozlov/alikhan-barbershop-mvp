// Карточка записи в разделе "Расписание" (13.08.2026, 6 правок Влада по живому
// интерфейсу). Тест держит именно ТО, что было решено убрать/перенести: разметка
// карточки уже дважды переезжала (Окно 55 - из #bd-1 в общую форму), и без такой
// проверки убранный блок легко возвращается следующей правкой того же файла.
//
// crm-master.html сознательно НЕ проверяется на отсутствие блока "Добавить услугу
// к записи": у мастера общей формы записи нет вообще (мастер записи не создаёт и не
// переносит - решение Влада 08.08.2026), и этот блок остаётся его единственным
// способом дописать услугу к визиту.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const OPERATOR_PAGES = ['crm-owner.html', 'crm-admin.html'];

test('заголовок списка услуг - без пояснения в скобках', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.match(html, /<summary>Услуги<\/summary>/, page);
    assert.doesNotMatch(html, /можно выбрать несколько/, page);
  }
});

test('отдельного блока "Добавить услугу к записи" у владельца и админа больше нет', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.doesNotMatch(html, /<summary>Добавить услугу к записи<\/summary>/, page);
    assert.doesNotMatch(html, /id="bkServiceEditPicker"|id="bkServiceEditSave"/, page);
  }
});

// 13.08.2026 (spec 2026-08-13-master-booking-card.md): отдельный блок был у мастера
// ровно потому, что общей формы записи на его странице не существовало - он открывал
// старую карточку #bd-1. Теперь форма у него есть, и список услуг в ней тот же самый,
// что у владельца с админом. Второй интерфейс для той же операции больше не нужен.
test('отдельного блока "Добавить услугу к записи" не осталось НИ НА ОДНОЙ странице', async () => {
  for (const page of [...OPERATOR_PAGES, 'crm-master.html']) {
    const html = await source(page);
    assert.doesNotMatch(html, /<summary>Добавить услугу к записи<\/summary>/, page);
    assert.doesNotMatch(html, /id="bkServiceEditPicker"|id="bkServiceEditSave"/, page);
  }
  // У владельца и админа услуги правятся общим списком формы; у мастера правки нет
  // вообще (13.08.2026, вторая итерация) - он видит состав визита списком на просмотр.
  for (const page of OPERATOR_PAGES) {
    assert.match(await source(page), /id="wfServicePicker"/, page);
  }
  assert.match(await source('crm-master.html'), /id="mbServices"/);
});

test('фактическая сумма - без "если отличается", без стрелок шага, с комментарием рядом', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.doesNotMatch(html, /если отличается от суммы услуг выше/, page);
    // type="number" рисует спиннер с шагом 1 - ровно то, на что жаловался Влад
    assert.match(html, /id="bkActualPrice" type="text" inputmode="numeric"/, page);
    assert.match(html, /id="bkStaffComment"/, page);
    assert.match(html, /Подставлена сумма выбранных услуг/, page);
  }
});

test('удаление записи - в самом низу карточки, ниже кнопок сохранения', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.match(html, /id="wfDangerZone"/, page);
    // Порядок в DOM: сначала кнопки сохранения, потом зона удаления
    assert.ok(html.indexOf('id="wfSubmit"') < html.indexOf('id="bkDeleteRow"'), `${page}: удаление должно идти после кнопок сохранения`);
    // И зона удаления - последний блок формы записи, после продажи
    assert.ok(html.indexOf('id="wfSaleForm"') < html.indexOf('id="wfDangerZone"'), `${page}: зона удаления должна быть последней`);
  }
});

test('кнопки сохранения разведены по вертикали, а не слиплись', async () => {
  const css = await source('assets/mockup-crm.css');
  assert.match(css, /\.wf-actions \{[^}]*margin-top: 26px/);
  assert.match(css, /\.wf-edit-extras > \.btn \{[^}]*margin-top: 14px/);
});

test('сумма подтягивается из состава услуг и не затирает ручную правку', async () => {
  const walkin = await source('assets/crm-walkin.js');
  const status = await source('assets/crm-booking-status.js');
  // Пересчёт зовётся именно из renderSummary - то есть на каждое изменение состава
  assert.match(walkin, /window\.syncBookingActualPrice\?\.\(totalPrice\)/);
  assert.match(status, /window\.syncBookingActualPrice = function/);
  assert.match(status, /if \(priceTouched\) return;/);
});

test('услуги записи редактируются целиком: снятая галочка уезжает на сервер', async () => {
  const walkin = await source('assets/crm-walkin.js');
  // Полный состав, а не только добавленные - иначе снятие услуги ничего не меняло бы
  assert.match(walkin, /method: 'PUT'[\s\S]{0,200}serviceIds: \[\.\.\.selected\]/);
  assert.match(walkin, /const removed = \[\.\.\.was\]\.filter/);
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.match(html, /id="wfServiceEditHint"/, page);
    assert.match(html, /услугу можно снять или добавить/, page);
  }
});

test('цвет записи в календаре говорит об исходе визита', async () => {
  const calendar = await source('assets/crm-calendar.js');
  const css = await source('assets/mockup-crm.css');
  // Неявка получает СВОЙ класс, а не тот же, что у ожидания
  assert.match(calendar, /'no_show' \? 'appt--noshow'/);
  assert.match(css, /\.appt--noshow \{[^}]*border-color: var\(--danger\)/);
  // Полосы слева: ожидание нейтральное, пришёл зелёный, не пришёл красный
  assert.match(css, /\.appt--status-planned \{ border-left-color: var\(--accent\); \}/);
  assert.match(css, /\.appt--status-done \{ border-left-color: var\(--success\); \}/);
  assert.match(css, /\.appt--status-noshow \{ border-left-color: var\(--danger\); \}/);
});
