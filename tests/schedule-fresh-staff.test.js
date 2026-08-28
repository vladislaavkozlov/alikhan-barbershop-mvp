// Расписание перечитывает состав сотрудников (28.08.2026, находка Влада на кабинете
// клиники Карины).
//
// Что было: состав для колонок «Дня» снимался ОДИН раз при входе. Владелец включал
// сотруднику «принимает клиентов», задавал рабочую неделю, сохранял - и расписание
// оставалось пустым, потому что в снимке у этого человека всё ещё «графика нет».
// Помогала только перезагрузка страницы, о которой обычный пользователь не догадается.
// Влад прошёл ровно этот путь и решил, что система сломана.
//
// Здесь стережётся сам факт: renderDayCalendar обязана строить список колонок из
// свежего ответа сервера, а не из аргумента staffList.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../assets/crm-calendar.js', import.meta.url), 'utf8');

test('состав колонок берётся из свежего ответа сервера, а не из снимка при входе', () => {
  assert.match(
    source,
    /const freshStaff = await freshStaffById\(fetchJson\);[\s\S]{0,200}const masters = isSolo \? \[staff\] : mastersOf\(freshList\)/,
    'колонки снова строятся по снимку staffList - включённый график не появится без перезагрузки'
  );
});

test('состав запрашивается один раз за отрисовку, а не дважды', () => {
  const calls = source.match(/await freshStaffById\(/g) ?? [];
  assert.equal(calls.length, 1, `лишний запрос состава: ${calls.length}`);
});

test('кнопка «Обновить данные» перерисовывает и само расписание', async () => {
  // Вторая половина той же находки 28.08.2026: состав стал свежим, но кнопка
  // обновления день не трогала вовсе - в списке её вызовов были все разделы, кроме
  // расписания, ради которого её обычно и жмут
  const page = await readFile(new URL('../crm-owner.html', import.meta.url), 'utf8');
  // Границу берём по ВЫЗОВУ, а не по имени: имя встречается выше в импорте, и срез по
  // нему давал пустую строку - тест падал на исправном коде
  const start = page.indexOf('window.__refreshOwnerDashboard');
  const block = page.slice(start, page.indexOf('initCrmRefreshControl();', start));
  assert.match(block, /window\.__refreshScheduleViews\?\.\(\)/, 'обновление не перерисовывает день');
});
