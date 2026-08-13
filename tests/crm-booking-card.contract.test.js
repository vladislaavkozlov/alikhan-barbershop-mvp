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

test('мастер сохраняет свой блок добавления услуги - другой страницы для этого у него нет', async () => {
  const html = await source('crm-master.html');
  assert.match(html, /<summary>Добавить услугу к записи<\/summary>/);
  assert.match(html, /id="bkServiceEditPicker"/);
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

test('уже оказанные услуги заблокированы в самом списке услуг', async () => {
  const walkin = await source('assets/crm-walkin.js');
  assert.match(walkin, /lockedServices = new Set\(editMode/);
  assert.match(walkin, /input\.disabled = isLocked \|\|/);
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.match(html, /id="wfServiceEditHint"/, page);
  }
});
