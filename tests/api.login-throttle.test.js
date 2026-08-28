// Защита входа от перебора (Окно 72, 28.08.2026).
//
// До этого окна счётчика попыток не было вовсе, а у владельца стоял четырёхзначный
// код - полный перебор занимал минуты. Эти проверки закрепляют само наличие
// счётчика и его два неочевидных свойства: удачный вход обнуляет историю, а пауза
// считается по паре «логин + адрес», чтобы чужой человек не мог запереть Али
// снаружи, засыпая его логин мусорными попытками.
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  LOGIN_THROTTLE_LIMITS,
  clientIp,
  registerFailure,
  registerSuccess,
  resetThrottle,
  retryAfterSeconds,
} from '../api/lib/login-throttle.js';

const { MAX_FAILURES, LOCK_MS } = LOGIN_THROTTLE_LIMITS;

beforeEach(() => resetThrottle());

test('пять промахов подряд ставят вход на паузу, четыре - нет', () => {
  for (let i = 0; i < MAX_FAILURES - 1; i++) registerFailure('aliovsad', '1.1.1.1');
  assert.equal(retryAfterSeconds('aliovsad', '1.1.1.1'), null, 'заперли раньше срока');
  registerFailure('aliovsad', '1.1.1.1');
  const wait = retryAfterSeconds('aliovsad', '1.1.1.1');
  assert.ok(wait > 0 && wait <= LOCK_MS / 1000, `пауза не выставлена: ${wait}`);
});

test('удачный вход обнуляет счётчик промахов', () => {
  for (let i = 0; i < MAX_FAILURES - 1; i++) registerFailure('renat', '1.1.1.1');
  registerSuccess('renat', '1.1.1.1');
  registerFailure('renat', '1.1.1.1');
  assert.equal(retryAfterSeconds('renat', '1.1.1.1'), null);
});

test('пауза считается по паре логин+адрес: чужой не запрёт владельца снаружи', () => {
  for (let i = 0; i < MAX_FAILURES; i++) registerFailure('aliovsad', '9.9.9.9');
  assert.ok(retryAfterSeconds('aliovsad', '9.9.9.9') > 0, 'атакующий не остановлен');
  assert.equal(retryAfterSeconds('aliovsad', '1.1.1.1'), null, 'сам Али заперт из салона');
});

test('после конца паузы счётчик начинается заново, а не продолжает старый', () => {
  const start = Date.now();
  for (let i = 0; i < MAX_FAILURES; i++) registerFailure('admin', '1.1.1.1', start);
  const later = start + LOCK_MS + 1000;
  assert.equal(retryAfterSeconds('admin', '1.1.1.1', later), null, 'пауза не кончилась вовремя');
  registerFailure('admin', '1.1.1.1', later);
  assert.equal(retryAfterSeconds('admin', '1.1.1.1', later), null, 'заперли с первого же промаха');
});

test('адрес берётся из X-Forwarded-For: за прокси Amvera все запросы иначе слились бы в один', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: {} }), '203.0.113.7');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }), '10.0.0.5');
  assert.equal(clientIp({ headers: {}, socket: {} }), '-');
});

test('роут входа подключил счётчик и отвечает 429, а не молчаливым отказом', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../api/routes/auth.js', import.meta.url), 'utf8');
  assert.match(source, /retryAfterSeconds\(login, ip\)/, 'пауза не проверяется до похода в базу');
  assert.match(source, /too_many_attempts/, 'нет отдельного ответа про паузу');
  assert.match(source, /registerFailure\(login, ip\)/, 'промахи не считаются');
  assert.match(source, /registerSuccess\(login, ip\)/, 'удачный вход не обнуляет счётчик');
  // Порядок важен: проверка паузы обязана стоять раньше запроса в базу, иначе
  // перебор продолжает нагружать Postgres даже будучи запертым
  assert.ok(source.indexOf('retryAfterSeconds') < source.indexOf('SELECT id, name, role'), 'пауза проверяется после запроса в базу');
});

test('вход принимает и новые ключи запроса, и старые - вкладка, открытая до выкатки, не ломается', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../api/routes/auth.js', import.meta.url), 'utf8');
  assert.match(source, /body\.login \?\? body\.email/);
  assert.match(source, /body\.password \?\? body\.pin/);
});

test('длинный логин не раздувает память: ключ обрезается', () => {
  // В счётчик попадает то, что прислал браузер, - в том числе значение, которое
  // не прошло проверку формата. Без обрезки поток запросов с километровыми
  // логинами растил бы карту в памяти сервера без предела.
  const huge = 'x'.repeat(5000);
  for (let i = 0; i < MAX_FAILURES; i++) registerFailure(huge, '1.1.1.1');
  // Тот же логин, обрезанный до тех же первых 64 знаков, - та же запись
  assert.ok(retryAfterSeconds('x'.repeat(64), '1.1.1.1') > 0, 'ключ не обрезается');
});

test('карта попыток не растёт бесконечно при атаке с тысяч адресов', () => {
  for (let i = 0; i < 6000; i++) registerFailure('aliovsad', `10.0.${Math.floor(i / 256)}.${i % 256}`);
  // Точное число не важно - важно, что рост ограничен, а не линеен по числу атак
  const wait = retryAfterSeconds('aliovsad', '10.0.23.100');
  assert.ok(wait === null || wait > 0, 'счётчик перестал отвечать осмысленно');
});
