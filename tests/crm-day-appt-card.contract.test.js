// Карточка записи в виде «День» (17.08.2026, задача Влада: имя + номер тем, у кого
// есть права + откуда пришёл клиент; «+1 новый клиент» только новому; у записи на
// 15 минут - опция раскрыть).
//
// Проверяется вывод самой buildApptCard (assets/crm-calendar.js) - она чистая
// («бронь → разметка»), DOM для неё не нужен. Правило «источник только новому»
// держится здесь, а не регуляркой по исходнику: именно оно решает, увидит ли
// администратор канал привлечения у постоянного клиента, где он уже неактуален.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApptCard } from '../assets/crm-calendar.js';

const services = [{ id: 'strizhka', name: 'Стрижка' }];
const priceOf = () => 1500;
const ctx = { masterName: 'Алиовсад', services, priceOf };

const booking = (extra = {}) => ({
  id: 'b-1',
  masterId: 'master-1',
  date: '2026-08-17',
  startTime: '12:00',
  endTime: '12:40',
  status: 'planned',
  serviceIds: ['strizhka'],
  clientName: 'Сергей',
  ...extra,
});

test('новый клиент: на карточке метка и канал, откуда он пришёл', () => {
  const html = buildApptCard(booking({ clientIsNew: true, clientSource: '2gis', clientPhone: '+79001234567' }), ctx);
  assert.match(html, /\+1 новый клиент/);
  assert.match(html, /2ГИС/);
  assert.match(html, /\+79001234567/);
});

// Буквально по задаче: "если уже обслуживался, то не отображать комментарий".
test('постоянный клиент: канала на карточке нет, телефон остаётся', () => {
  const html = buildApptCard(booking({ clientIsNew: false, clientSource: '2gis', clientPhone: '+79001234567' }), ctx);
  assert.doesNotMatch(html, /2ГИС/);
  assert.doesNotMatch(html, /новый клиент/);
  assert.match(html, /\+79001234567/);
});

// Телефон и канал мастеру не приходят с сервера вовсе (listBookingsForRequest) -
// карточка не должна рисовать пустых хвостов вроде "Сергей · " на их месте.
test('роль без прав на телефон: строка деталей не появляется пустой', () => {
  const html = buildApptCard(booking({ clientIsNew: true }), ctx);
  assert.match(html, /\+1 новый клиент/);
  assert.doesNotMatch(html, /class="s">\s*<\/span>/);
});

test('клиент без метки новизны и без канала: третьей строки нет вовсе', () => {
  const html = buildApptCard(booking(), ctx);
  assert.doesNotMatch(html, /class="s"/);
});

// Данные для формы редактирования едут на самой карточке, как уже сделано у
// комментария и фактической суммы - лишний запрос за той же бронью не нужен.
test('канал уезжает в data-атрибут для формы правки', () => {
  const html = buildApptCard(booking({ clientIsNew: true, clientSource: 'yandex_maps' }), ctx);
  assert.match(html, /data-client-source="yandex_maps"/);
  assert.match(html, /data-client-new="true"/);
});

test('короткая запись: кнопка раскрытия есть и у неё, и у обычной', () => {
  const short = buildApptCard(booking({ endTime: '12:15' }), ctx);
  const normal = buildApptCard(booking(), ctx);
  assert.match(short, /class="appt-expand"/);
  assert.match(short, /appt--compact/); // 15 минут - режим, где строки скрыты
  assert.match(normal, /class="appt-expand"/);
  assert.doesNotMatch(normal, /appt--compact/);
});

// Кнопка раскрытия лежит ВНУТРИ кликабельной карточки: без остановки всплытия
// каждое раскрытие открывало бы ещё и форму записи.
test('кнопка раскрытия зовёт свой обработчик и получает событие для остановки', () => {
  const html = buildApptCard(booking(), ctx);
  assert.match(html, /onclick="window\.toggleApptExpand\(this, event\)"/);
  assert.match(html, /aria-expanded="false"/);
});

// Отменённая запись некликабельна целиком (buildCancelledCard) - раскрывать в ней
// нечего, и кнопка на ней была бы обещанием, которого интерфейс не выполняет.
test('отменённая запись: без кнопки раскрытия и без данных клиента', () => {
  const html = buildApptCard(booking({ status: 'cancelled', clientIsNew: true, clientSource: '2gis' }), ctx);
  assert.doesNotMatch(html, /appt-expand/);
  assert.doesNotMatch(html, /2ГИС/);
  assert.match(html, /отменено/);
});

// Имя клиента приходит из базы и попадает в разметку строкой - защита от инъекции
// та же, что у остального содержимого карточки.
test('имя с угловыми скобками экранируется, а не выполняется', () => {
  const html = buildApptCard(booking({ clientName: '<img src=x onerror=alert(1)>' }), ctx);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
