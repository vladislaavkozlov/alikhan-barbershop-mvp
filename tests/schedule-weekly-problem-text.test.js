// 17.08.2026 (вечер) - Влад по живому экрану: «в чём здесь конкретно ошибка? Что
// перерыв вне рабочего дня? - тогда так и нужно написать в ошибке в конкретном случае -
// что "перерыв должен быть внутри рабочего графика" или типа того». Плюс второй случай
// от него же: перерыв с 05:15 до 05:15 давал ту же общую фразу.
//
// Форма графика проверяет время до отправки и называет причину словами - с днём недели
// и часами, которые человек сам и выбрал. Проверяем именно ТЕКСТ: он и есть фича.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeWeeklyChanges } from '../api/lib/schedule-core.js';

// firstWeeklyProblem живёт в модуле, который тянет DOM-зависимости (crm-widgets и др.),
// поэтому в офлайн-тесте берём саму функцию из файла - без загрузки всего графа
const source = readFileSync(new URL('../assets/crm-schedule-editor.js', import.meta.url), 'utf8');
const fnSource = source.slice(
  source.indexOf('const WEEKDAY_FULL'),
  source.indexOf('// Русский список конфликтующих броней')
);
const firstWeeklyProblem = new Function(`${fnSource.replace(/export function/g, 'function')}; return firstWeeklyProblem;`)();

const workday = (over = {}) => [{ weekday: 3, isWorking: true, workStart: '10:00', workEnd: '20:00', breakStart: null, breakEnd: null, ...over }];

test('правильный день недели не вызывает ни одного замечания', () => {
  assert.equal(firstWeeklyProblem(workday()), null);
  assert.equal(firstWeeklyProblem(workday({ breakStart: '13:00', breakEnd: '14:00' })), null);
  assert.equal(firstWeeklyProblem([{ weekday: 1, isWorking: false }]), null);
});

test('случай Влада №1: перерыв 13:00-14:00 при рабочем дне 00:00-08:00', () => {
  const text = firstWeeklyProblem(workday({ workStart: '00:00', workEnd: '08:00', breakStart: '13:00', breakEnd: '14:00' }));
  assert.match(text, /^Среда:/); // назван день, а не «проверьте время»
  assert.match(text, /перерыв 13:00-14:00/);
  assert.match(text, /вне рабочего дня 00:00-08:00/);
  assert.match(text, /внутри рабочего времени/);
});

test('случай Влада №2: перерыв с 05:15 до 05:15 - своя фраза, не про «вне графика»', () => {
  const text = firstWeeklyProblem(workday({ workStart: '00:00', workEnd: '08:00', breakStart: '05:15', breakEnd: '05:15' }));
  assert.match(text, /^Среда:/);
  assert.match(text, /перерыв стоит с 05:15 до 05:15/);
  assert.match(text, /конец перерыва должен быть позже начала/);
  assert.doesNotMatch(text, /вне рабочего дня/);
});

test('перевёрнутый рабочий день объясняется своими часами', () => {
  const text = firstWeeklyProblem(workday({ workStart: '23:00', workEnd: '01:00' }));
  assert.match(text, /^Среда: рабочий день стоит с 23:00 до 01:00/);
  assert.match(text, /конец должен быть позже начала/);
});

test('называется первый проблемный день, и именно он', () => {
  const rows = [
    { weekday: 1, isWorking: true, workStart: '10:00', workEnd: '20:00' },
    { weekday: 5, isWorking: true, workStart: '10:00', workEnd: '20:00', breakStart: '21:00', breakEnd: '22:00' },
  ];
  assert.match(firstWeeklyProblem(rows), /^Пятница:/);
});

test('сервер отдаёт ту же причину кодом и днём - для заявки мастера и других клиентов', () => {
  const outside = analyzeWeeklyChanges([{ weekday: 3, isWorking: true, workStart: '00:00', workEnd: '08:00', breakStart: '13:00', breakEnd: '14:00' }]);
  assert.equal(outside.rows, null);
  assert.deepEqual(outside.error, {
    code: 'break_outside_work', weekday: 3,
    breakStart: '13:00', breakEnd: '14:00', workStart: '00:00', workEnd: '08:00',
  });

  const zeroBreak = analyzeWeeklyChanges([{ weekday: 3, isWorking: true, workStart: '00:00', workEnd: '08:00', breakStart: '05:15', breakEnd: '05:15' }]);
  assert.equal(zeroBreak.error.code, 'break_end_before_start');
  assert.equal(zeroBreak.error.weekday, 3);

  const flipped = analyzeWeeklyChanges([{ weekday: 2, isWorking: true, workStart: '23:00', workEnd: '01:00' }]);
  assert.equal(flipped.error.code, 'work_end_before_start');
  assert.equal(flipped.error.weekday, 2);

  const good = analyzeWeeklyChanges([{ weekday: 4, isWorking: true, workStart: '00:00', workEnd: '23:59' }]);
  assert.equal(good.error, null);
  assert.equal(good.rows.length, 1);
});

test('роуты отдают код в поле error - общий контракт ошибок API', () => {
  // Клиент читает код именно из error (describeError, assets/crm-toast.js): если роут
  // отдаст только внутреннее поле code, человек получит безымянную ошибку. Поймано
  // живым прогоном 17.08.2026, сначала так и было
  for (const file of ['../api/routes/schedule.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /sendJson\(res, 400, \{ error: weeklyError\.code, \.\.\.weeklyError \}\)/, `${file} не отдаёт код в поле error`);
  }
});

test('у каждого серверного кода есть человеческий текст в CRM', () => {
  const toast = readFileSync(new URL('../assets/crm-toast.js', import.meta.url), 'utf8');
  for (const code of ['invalid_weekly_changes', 'missing_work_time', 'missing_break_time', 'work_end_before_start', 'break_end_before_start', 'break_outside_work']) {
    assert.match(toast, new RegExp(`${code}:\\s*'[^']+'`), `нет текста для кода ${code}`);
  }
});
