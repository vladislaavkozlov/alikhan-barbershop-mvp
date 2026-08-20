// Смена PIN: только владелец, и сразу всем (решение Влада 20.08.2026).
//
// До этого модель была обратной и дырявой сразу с двух сторон: каждый сотрудник
// менял свой PIN сам (PUT /auth/pin, auth: 'any-staff'), а у владельца формы не
// было вовсе - единственный человек с полным доступом не мог сменить себе пароль
// через интерфейс. Сбросить чужой PIN тоже было нечем: такого роута не
// существовало, временный выдавался только при заведении нового сотрудника.
//
// Проверяется реестр роутов, а не обработчики: решение «кто вообще допущен» на
// этом сервере принимает именно он (server.mjs, гейт до if/else), и обработчик
// чужой роли не видит в принципе. Postgres здесь не нужен - тот же приём, что в
// api.staff-role-lock.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute } from '../api/server.mjs';
import { isValidPin } from '../api/routes/staff.js';
import { readFileSync } from 'node:fs';

const put = (path) => matchRoute('PUT', path.split('/').filter(Boolean));

test('новый роут задания PIN существует и пускает ТОЛЬКО владельца', () => {
  const route = put('staff/master-3/pin');
  assert.ok(route, 'PUT /staff/:id/pin должен быть в реестре');
  assert.equal(route.auth, 'owner');
});

test('владельцу не запрещено задать PIN самому себе', () => {
  // Ровно то, чего не хватало: у Алиовсада (owner) не было ни одного способа
  // сменить свой PIN из интерфейса. Путь тот же, что для остальных.
  assert.equal(put('staff/master-1/pin').auth, 'owner');
});

test('самостоятельная смена своего PIN закрыта: PUT /auth/pin больше не роут', () => {
  // Не «обработчик отвечает 401», а именно отсутствие в реестре: незарегистрированный
  // метод+путь получает 404 на гейте. Оставить роут живым значило бы держать
  // обходную дверь мимо правила «пины задаёт владелец».
  assert.ok(!put('auth/pin'), 'PUT /auth/pin не должен находиться в реестре');
});

test('управление ролями осталось management, его этой правкой не задело', () => {
  // Регрессия: 'management' шире, чем 'owner' (туда входит и управляющий). Если бы
  // новый роут случайно получил этот уровень, пины смог бы менять и Мамедхан.
  assert.equal(put('staff/master-3/role').auth, 'management');
  assert.notEqual(put('staff/master-3/pin').auth, 'management');
});

test('PIN - ровно шесть цифр, старые четырёхзначные больше не годятся', () => {
  // Боевые PIN на момент правки: у владельца и мастера они четырёхзначные
  // (наследие раннего прода), у администратора - шестизначный. Форма владельца
  // и сервер держат одно правило, поэтому короткие при переустановке не пройдут.
  assert.equal(isValidPin('517563'), true);
  assert.equal(isValidPin('4495'), false);
  assert.equal(isValidPin('0708'), false);
  assert.equal(isValidPin('1234567'), false);
  assert.equal(isValidPin('12a456'), false);
  assert.equal(isValidPin(''), false);
  assert.equal(isValidPin(undefined), false);
});

test('обработчик проверяет роль сам, не полагаясь только на гейт реестра', () => {
  // Защита в глубину. Гейт уже не пустит чужого, но все соседние обработчики
  // staff проверяют права ещё и у себя. Эндпоинт, который ЗАДАЁТ ПАРОЛЬ, обязан
  // держать тот же замок: если уровень в реестре однажды поменяют или появится
  // второй путь к обработчику, проверка внутри останется.
  const src = readFileSync(new URL('../api/routes/staff.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function handleStaffPinSet'));
  assert.match(body.slice(0, 1200), /requireRole\(auth, \['owner'\]\)/);
});

test('идентификатор сотрудника уходит в SQL параметром, а не склейкой строки', () => {
  const src = readFileSync(new URL('../api/routes/staff.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function handleStaffPinSet'));
  const query = body.slice(0, 1600);
  assert.match(query, /WHERE id = \$2/);
  assert.doesNotMatch(query, /WHERE id = '\$\{/);
});
