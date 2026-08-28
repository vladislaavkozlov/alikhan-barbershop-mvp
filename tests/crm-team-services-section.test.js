// 27.08.2026, находка владельца: «в личных данных администратора какой-то баг, у него
// отображается, что у него якобы есть какие-то услуги (хоть и приглушенные)».
//
// Причина была не в правах, а в разметке: секция «Услуги и время» рисовалась в карточке
// сотрудника безусловно (assets/crm-team.js), а признак providesServices влиял только на
// право менять галки. Администратор получал весь каталог услуг под стилем
// .service-picker.readonly - «есть, но трогать нельзя» вместо «этого у меня нет».
//
// Тест держит границу правки: решение принимает одна чистая функция, и контейнер услуг
// в исходнике живёт только под этим условием. Поведение мастера не меняется ни на йоту,
// в том числе когда поля providesServices в снимке состава нет вовсе.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// crm-team.js - браузерный модуль: на верхнем уровне он подписывается на события
// документа. Заглушки ровно под это, DOM здесь не проверяется - проверяется решение.
const noop = () => {};
globalThis.document ??= { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
globalThis.window ??= { addEventListener: noop, location: { search: '' } };
globalThis.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };

const { showsServicesSection } = await import('../assets/crm-team.js');

test('администратор услуг не оказывает - секции услуг у него нет', () => {
  assert.equal(showsServicesSection({ id: 'a1', name: 'Администратор', role: 'admin', providesServices: false }), false);
});

test('мастер принимает клиентов - секция услуг на месте', () => {
  assert.equal(showsServicesSection({ id: 'm1', name: 'Мамедхан', role: 'master', providesServices: true }), true);
});

test('поля providesServices нет вовсе - у мастера секцию не прячем', () => {
  assert.equal(showsServicesSection({ id: 'm2', name: 'Старый снимок состава', role: 'master' }), true);
});

test('пустой вход не роняет расчёт', () => {
  assert.equal(showsServicesSection(null), true);
  assert.equal(showsServicesSection(undefined), true);
});

// Уволенный мастер остаётся мастером: услуги в его карточке - это история компетенций,
// а не приём клиентов. Секцию ему оставляем, критерий здесь ровно один - providesServices
test('уволенный, но принимавший клиентов - секция услуг остаётся', () => {
  assert.equal(showsServicesSection({ id: 'm3', providesServices: true, employed: false }), true);
});

test('контейнер услуг в разметке карточки живёт только под условием показа', async () => {
  const source = await readFile(new URL('../assets/crm-team.js', import.meta.url), 'utf8');
  const lines = source.split('\n').map((line, index) => [index + 1, line]);
  const markup = lines.filter(([, line]) => line.includes('<div class="service-picker"'));
  assert.equal(markup.length, 1, 'контейнер услуг рисуется ровно в одном месте');
  assert.match(markup[0][1], /showsServicesSection\(staff\) \? section\(/);
});

// Контейнера у того, кто клиентов не принимает, больше нет вовсе - редактор услуг обязан
// это учитывать, иначе renderTeam упал бы на null и раздел «Команда» не нарисовался бы
test('renderTeam зовёт редактор услуг только когда контейнер найден', async () => {
  const source = await readFile(new URL('../assets/crm-team.js', import.meta.url), 'utf8');
  const call = source.indexOf('renderMasterServiceEditor(picker, staff.id');
  assert.ok(call > 0, 'вызов редактора услуг на месте');
  const before = source.slice(source.lastIndexOf('const picker = host.querySelector', call), call);
  assert.match(before, /if \(picker\) \{/);
});
