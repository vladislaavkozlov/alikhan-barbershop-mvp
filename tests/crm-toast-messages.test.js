// Правка Влада 15.08.2026: "все возможные такие ошибки должны быть минимально
// информативными (чтобы не просто код какой-то, а из-за чего ошибка)". Здесь
// проверяется расшифровка: любой отказ сервера превращается в фразу на русском, а
// технические хвосты ("/staff → 500", "Failed to fetch") наружу не выходят.
//
// Чистые функции модуля, DOM не нужен - сам показ окна проверяется живым прогоном
// tools/verify-2026-08-15-vsplyvayushchie-oshibki.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const { describeError, errorMessage, errorTextByCode } = await import('../assets/crm-toast.js');

test('каждый код ошибки сервера переведён на человеческий язык', async () => {
  const root = new URL('../', import.meta.url);
  const files = ['api/routes/services.js', 'api/routes/staff.js', 'api/routes/bookings.js', 'api/routes/schedule.js',
    'api/routes/payroll.js', 'api/routes/clients.js', 'api/routes/auth.js',
    'api/routes/notifications.js', 'api/server.mjs'];
  const codes = new Set();
  for (const file of files) {
    const source = await readFile(new URL(file, root), 'utf8').catch(() => '');
    for (const match of source.matchAll(/error: '([a-z_]+)'/g)) codes.add(match[1]);
  }
  assert.ok(codes.size > 20, `кодов найдено подозрительно мало: ${codes.size}`);
  const untranslated = [...codes].filter((code) => !errorTextByCode(code));
  assert.deepEqual(untranslated, [], `эти коды покажутся человеку как есть: ${untranslated.join(', ')}`);
});

test('ни один перевод не выглядит как код', () => {
  for (const code of ['invalid_duration', 'schedule_conflict', 'portfolio_limit', 'last_owner_role_locked']) {
    const text = errorTextByCode(code);
    assert.ok(/^[А-ЯЁ]/.test(text), `${code}: перевод должен начинаться с русской буквы, получено "${text}"`);
    assert.doesNotMatch(text, /_|[a-z]{4,}/, `${code}: в тексте остались машинные куски - "${text}"`);
  }
});

test('ответ apiSend превращается в причину: код важнее статуса', () => {
  assert.equal(describeError({ ok: false, status: 400, data: { error: 'invalid_duration' } }), 'Длительность услуги должна быть больше 0 минут');
  assert.equal(describeError({ ok: false, status: 409, data: { error: 'schedule_conflict' } }), 'На это время уже есть запись');
});

test('незнакомый код - объясняем хотя бы по статусу ответа', () => {
  assert.equal(describeError({ status: 403, data: { error: 'какой_то_новый_код' } }), 'У вашей роли нет прав на это действие');
  assert.equal(describeError({ status: 503, data: null }), 'Сервер перезапускается. Повторите через минуту');
});

test('технический хвост старого формата наружу не показывается', () => {
  const err = Object.assign(new Error('/staff → 500'), { status: 500 });
  assert.equal(describeError(err), 'Сервер не смог обработать запрос. Попробуйте ещё раз');
  assert.doesNotMatch(errorMessage(err, 'Не удалось сохранить'), /→|500/);
});

test('пропавшая сеть объясняется человеку, а не браузерным текстом', () => {
  assert.equal(describeError(new TypeError('Failed to fetch')), 'Нет связи с сервером. Проверьте интернет');
  assert.equal(describeError(new TypeError('NetworkError when attempting to fetch resource.')), 'Нет связи с сервером. Проверьте интернет');
});

test('готовая фраза без приставки уходит на экран как есть', () => {
  assert.equal(errorMessage('Укажите дату'), 'Укажите дату');
  assert.equal(errorMessage({ status: 400, data: { error: 'invalid_duration' } }, 'Не удалось сохранить услуги'),
    'Не удалось сохранить услуги: Длительность услуги должна быть больше 0 минут');
});

test('причина неизвестна - человек всё равно понимает, что делать', () => {
  assert.equal(errorMessage({ status: 418, data: null }, 'Не удалось сохранить'), 'Не удалось сохранить. Повторите попытку');
});
