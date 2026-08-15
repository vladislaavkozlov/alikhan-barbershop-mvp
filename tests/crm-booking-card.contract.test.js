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

// Вторая итерация правок 13.08.2026: заголовка у списка услуг больше нет вовсе
// ("надпись 'Услуги' убираем, сами услуги оставляем в такой же пунктирной рамке на
// виду, сворачивать их не нужно"), поэтому и пояснению в скобках взяться неоткуда.
// Рамка осталась (.service-edit), но блок больше не <details> - разворачивать нечего.
test('список услуг - без заголовка и без сворачивания, в той же пунктирной рамке', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.doesNotMatch(html, /<summary>Услуги<\/summary>/, page);
    assert.doesNotMatch(html, /можно выбрать несколько/, page);
    assert.match(html, /<div class="service-edit service-edit--flat">\s*<div class="service-picker" id="wfServicePicker">/, page);
  }
  // Рамка та же самая, что была у <details> - отдельный класс только добавляет
  // верхний отступ вместо ушедшего заголовка
  const css = await source('assets/mockup-crm.css');
  assert.match(css, /\.service-edit \{[^}]*border: 1px dashed/);
  assert.match(css, /\.service-edit--flat \{[^}]*padding:/);
});

// 13.08.2026 (Влад): "Выбрано услуг: 1 · итого 60 мин · 3 500 ₽" и "Выберите хотя бы
// одну услугу" - обе строки убраны как избыточные ("и так понятно визуально"): цена и
// длительность каждой услуги видны в самом списке, а "услуг не выбрано" показывает
// неактивная кнопка сохранения.
test('строки итога по услугам в карточке нет', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    // Именно разметка, не упоминание в комментарии-объяснении рядом
    assert.doesNotMatch(html, /<p class="wf-summary"/, page);
    assert.doesNotMatch(html, /Выберите хотя бы одну услугу<\/p>/, page);
  }
  // Форма обязана работать и без этого элемента - иначе его удаление выключило бы
  // всю запись целиком (summary исключён из списка обязательных элементов)
  const walkin = await source('assets/crm-walkin.js');
  assert.doesNotMatch(walkin, /if \(!form \|\| !picker \|\| !summary/);
  assert.match(walkin, /if \(summary\) summary\.textContent/);
});

// "Мастер" стоял отдельной строкой .field-grid с field--wide (span 2) - дропдаун во
// всю ширину панели в пустой строке (Влад: "слайд выбранного мастера странно смотрится
// на длину всей панели"). Теперь это обычное поле в одной строке с датой и временем.
test('мастер - поле в строке даты и времени, не отдельная строка во всю ширину', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.doesNotMatch(html, /<div class="field-grid" id="wfMasterRow"/, page);
    assert.match(
      html,
      /id="wfDateTimeRow"[\s\S]{0,400}<div class="field" id="wfMasterRow" hidden><label>Мастер<\/label>/,
      page,
    );
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

test('фактическая сумма - без подписей-пояснений, без стрелок шага, с комментарием рядом', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.doesNotMatch(html, /если отличается от суммы услуг выше/, page);
    // type="number" рисует спиннер с шагом 1 - ровно то, на что жаловался Влад
    assert.match(html, /id="bkActualPrice" type="text" inputmode="numeric"/, page);
    assert.match(html, /id="bkStaffComment"/, page);
    // Вторая итерация 13.08.2026: обе подписи под полями убраны ("и так всё понятно")
    assert.doesNotMatch(html, /Подставлена сумма выбранных услуг/, page);
    assert.doesNotMatch(html, /Сохраняется в записи - будет видно и через месяц/, page);
  }
});

// 13.08.2026 (Влад): "кнопка 'Сохранить сумму и комментарий' как будто бы не нужна,
// т.к. уже есть кнопка 'Сохранить изменения'". Кнопок сохранения на одной карточке
// было две, и какая что сохраняет, приходилось угадывать.
test('своей кнопки у суммы и комментария нет - их сохраняет общая кнопка карточки', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.doesNotMatch(html, /<button[^>]*id="bkActualPriceSave"/, page);
    assert.doesNotMatch(html, /Сохранить сумму и комментарий<\/button>/, page);
  }
  const status = await source('assets/crm-booking-status.js');
  const walkin = await source('assets/crm-walkin.js');
  // Сам PATCH никуда не делся - он вынесен в функцию, которую зовёт общая кнопка
  assert.match(status, /window\.saveBookingActualPrice = async function/);
  assert.match(status, /\/actual-price/);
  assert.match(walkin, /await window\.saveBookingActualPrice\(\)/);
  // и только когда сумма или комментарий реально изменились
  assert.match(walkin, /const priceChanged = /);
});

// 13.08.2026 (Влад): "кнопка 'Сохранить изменения' должна быть неактивна до внесения
// изменений и должна учитывать изменения всех полей во вкладке"
test('кнопка "Сохранить изменения" гаснет, пока в записи ничего не изменили', async () => {
  const walkin = await source('assets/crm-walkin.js');
  // Снимок всех сохраняемых полей: мастер, дата, время, услуги, сумма, комментарий
  for (const field of ['masterId:', 'date:', 'startTime:', 'services:', 'actualPrice:', 'comment:']) {
    assert.match(walkin, new RegExp(`editStateSnapshot[\\s\\S]{0,600}${field}`), field);
  }
  assert.match(walkin, /function isEditDirty/);
  assert.match(walkin, /btn\.disabled = editMode\s*\n?\s*\? selected\.size === 0 \|\| !isEditDirty\(\)/);
  // Снимок берётся при открытии записи и заново после успешного сохранения
  assert.match(walkin, /editBaseline = editStateSnapshot\(\);/);
  // Поля, которые меняются мимо списка услуг, тоже поднимают признак изменения
  assert.match(walkin, /form\.addEventListener\('customselect:change', updateSubmitState\)/);
  assert.match(walkin, /form\.addEventListener\('customdate:change', updateSubmitState\)/);
  assert.match(walkin, /for \(const id of \['bkActualPrice', 'bkStaffComment'\]\)/);
});

// 13.08.2026 (Влад): "меняешь статус и нажимаешь сохранить - всплывает 'Изменений не
// было', хотя статус реально меняется". Статус входит в снимок наравне с остальным.
test('смена статуса визита поднимает кнопку сохранения', async () => {
  const walkin = await source('assets/crm-walkin.js');
  const status = await source('assets/crm-booking-status.js');
  // Один общий маппинг радио → статус, не вторая копия в другом файле
  assert.match(status, /export const RADIO_ID_TO_STATUS/);
  assert.match(walkin, /import \{ RADIO_ID_TO_STATUS, applyNoShowStreakAfterStatus \} from '\.\/crm-booking-status\.js'/);
  assert.match(walkin, /status: checkedStatusRadioId\(\)/);
  assert.match(walkin, /if \(e\.target\?\.name === 'bstatus'\) updateSubmitState\(\)/);
});

// 13.08.2026, вторая итерация (Влад): "важно, чтобы при корректировке записи
// изменения вступали в силу только при нажатии на кнопку 'Сохранить изменения'".
// Статус визита был единственным полем карточки, которое уезжало в базу сразу по
// клику - откатить случайную отметку неявки можно было только вторым запросом.
test('статус визита сохраняется общей кнопкой, а не кликом по радио', async () => {
  const status = await source('assets/crm-booking-status.js');
  const walkin = await source('assets/crm-walkin.js');
  // В обработчике радио не осталось ни одного запроса на изменение
  const radioWiring = status.slice(status.indexOf('export function wireBookingStatusRadios'), status.indexOf('export function applyNoShowStreakAfterStatus'));
  assert.doesNotMatch(radioWiring, /fetch\(/);
  assert.doesNotMatch(radioWiring, /method: 'PATCH'/);
  // Сам PATCH статуса живёт в общем сохранении карточки и сравнивается с реальным
  // статусом записи, а не со снимком для кнопки
  assert.match(walkin, /const prevStatus = form\.dataset\.realStatus \|\| editBooking\.status \|\| 'planned'/);
  assert.match(walkin, /if \(wantedStatus && wantedStatus !== prevStatus\)[\s\S]{0,400}\/status`/);
  // Счётчик неявок пересчитывается ПОСЛЕ ответа сервера, не по клику
  assert.match(status, /export function applyNoShowStreakAfterStatus/);
  assert.match(walkin, /applyNoShowStreakAfterStatus\(form, prevStatus, wantedStatus\)/);
});

// 13.08.2026 (Влад): "из надписи 'Сохранено: услуги, сумма и комментарий - Алиовсад,
// 2026-08-13 11:15' оставь только 'Сохранено'". Перечисление пересказывало карточку,
// которая и так на экране.
test('успешное сохранение записи отвечает одним словом', async () => {
  const walkin = await source('assets/crm-walkin.js');
  // 15.08.2026 - тот же одинокий текст теперь ещё и всплывает внизу экрана
  // (reportSuccess, assets/crm-toast.js): строка результата живёт внизу длинной
  // формы, и до неё приходилось листать
  assert.match(walkin, /reportSuccess\(resultEl, 'Сохранено'\);/);
  assert.doesNotMatch(walkin, /savedParts/);
  assert.doesNotMatch(walkin, /'Изменений не было'/);
  // Ошибка остаётся на том же месте и в красной рамке (.wf-result--err)
  assert.match(walkin, /resultEl\.className = 'wf-result wf-result--err'/);
  const css = await source('assets/mockup-crm.css');
  assert.match(css, /\.wf-result--err \{[^}]*border: 1px solid var\(--danger\)/);
});

// 13.08.2026 (Влад): "Пришёл" → "Обслужен" (клиент пришёл, подстригся, оплатил -
// сделка завершена), а цвет выбранного статуса - тот же, что у его записи в
// календаре "День": ожидание акцентное, обслужен зелёный, неявка красная.
test('статусы записи названы по смыслу и покрашены как записи в календаре', async () => {
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.match(html, /<label for="st-came">Обслужен<\/label>/, page);
    assert.doesNotMatch(html, /<label for="st-came">Пришёл<\/label>/, page);
  }
  const css = await source('assets/mockup-crm.css');
  assert.match(css, /#st-wait:checked ~ label\[for="st-wait"\] \{[^}]*border-color: var\(--accent\)/);
  assert.match(css, /#st-came:checked ~ label\[for="st-came"\] \{[^}]*border-color: var\(--success\)/);
  assert.match(css, /#st-no:checked ~ label\[for="st-no"\] \{[^}]*border-color: var\(--danger\)/);
  // Одно и то же название статуса на всех страницах CRM
  assert.match(await source('assets/crm-master-booking.js'), /done: 'Обслужен'/);
  assert.match(await source('assets/crm-clients.js'), /done: 'обслужен'/);
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

test('кнопки сохранения отделены воздухом от полей записи', async () => {
  const css = await source('assets/mockup-crm.css');
  assert.match(css, /\.wf-actions \{[^}]*margin-top: 26px/);
});

test('сумма подтягивается из состава услуг и не затирает ручную правку', async () => {
  const walkin = await source('assets/crm-walkin.js');
  const status = await source('assets/crm-booking-status.js');
  // Пересчёт зовётся именно из renderSummary - то есть на каждое изменение состава
  assert.match(walkin, /window\.syncBookingActualPrice\?\.\(totalPrice\)/);
  assert.match(status, /window\.syncBookingActualPrice = function/);
  assert.match(status, /if \(priceTouched\) return;/);
});

// 13.08.2026 (Влад): "добавляешь услугу - фактическая сумма растёт, а убираешь -
// сумма не уменьшается". Сохранённая сумма поднимала признак "правили руками" сама
// по себе, а она есть у любой уже сохранённой записи - поле замерзало навсегда.
test('фактическая сумма следует за составом услуг в обе стороны', async () => {
  const status = await source('assets/crm-booking-status.js');
  // Признак "ручная правка" - расхождение с составом, а не сам факт непустой суммы
  assert.doesNotMatch(status, /priceTouched = actualPrice != null;/);
  assert.match(status, /priceTouched = savedActualPrice != null && savedActualPrice !== servicesTotal/);
  // И то же правило после сохранения - иначе первое сохранение снова заморозит поле
  assert.match(status, /priceTouched = actualPrice != null && actualPrice !== lastServicesTotal/);
});

test('услуги записи редактируются целиком: снятая галочка уезжает на сервер', async () => {
  const walkin = await source('assets/crm-walkin.js');
  // Полный состав, а не только добавленные - иначе снятие услуги ничего не меняло бы
  assert.match(walkin, /method: 'PUT'[\s\S]{0,200}serviceIds: \[\.\.\.selected\]/);
  assert.match(walkin, /const removed = \[\.\.\.was\]\.filter/);
  // Подсказка "Отметьте, что мастер сделал по факту…" убрана 13.08.2026 (вторая
  // итерация правок Влада) - на саму механику снятия услуги это не влияет, но
  // элемента #wfServiceEditHint в разметке больше нет, и код обязан это переживать
  for (const page of OPERATOR_PAGES) {
    const html = await source(page);
    assert.doesNotMatch(html, /id="wfServiceEditHint"/, page);
  }
  assert.match(walkin, /if \(serviceEditHint\) serviceEditHint\.hidden/);
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
