// Влад, 16.08.2026: "Данные сохранены, а роль не изменилась: Такой роли не
// существует" + "кнопка Принимает клиентов... при изменении не меняется, не выдаёт
// сохранено".
//
// Причина у обоих симптомов одна. Роль, которую менять нельзя (карточка владельца, а
// у управляющего - любая чужая), рисуется функцией roleBadge: такая же на вид
// отмеченная радиокнопка, но disabled и БЕЗ атрибута value. У radio без value
// свойство `.value` равно строке "on" - именно она уезжала на сервер как роль, и
// сервер честно отвечал invalid_role. А поскольку шаг роли идёт до финального
// "Сохранено" и до перезагрузки расписания, сохранение обрывалось на полпути:
// переключённый тумблер "Принимает клиентов" в базу уже уехал, а человек видел
// только красную плашку про роль.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../assets/crm-team.js', import.meta.url), 'utf8');

test('роль читается только из включённой радиокнопки, не из бейджа', () => {
  assert.match(source, /input\[type="radio"\]:checked:not\(\[disabled\]\)/);
  // Старого селектора без отсечки disabled не осталось ни в сохранении, ни в снимке
  assert.doesNotMatch(source, /team-role-picker input\[type="radio"\]:checked'\)/);
});

test('бейдж нередактируемой роли по-прежнему без value - его и нельзя отправлять', () => {
  const badge = source.match(/function roleBadge[\s\S]*?\n}/)[0];
  assert.match(badge, /<input type="radio" checked disabled>/);
  assert.doesNotMatch(badge, /value=/);
});

test('роль уезжает на сервер только когда её реально сменили', () => {
  assert.match(source, /role\.value !== card\.dataset\.role/);
  // Исходная роль должна лежать на карточке, иначе сравнивать не с чем
  assert.match(source, /data-role="\$\{esc\(staff\.role\)\}"/);
});

test('после шага роли сохранение доходит до "Сохранено" и до обновления расписания', () => {
  const save = source.match(/async function saveCardSteps[\s\S]*?\n}/)[0];
  const roleStep = save.indexOf('/role');
  const okNote = save.indexOf("noteOk(card, 'Сохранено')");
  const reload = save.indexOf('window.location.reload()');
  assert.ok(roleStep > 0 && okNote > roleStep, 'подтверждение должно идти после шага роли');
  assert.ok(reload > okNote, 'перезагрузка расписания - последним шагом');
  assert.match(save, /providesServicesChanged/);
});
