import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function missing(path) {
  try { await access(new URL(path, root)); return false; } catch { return true; }
}

// История этого файла - две противоположные модели подряд, и обе стоит помнить.
//
// 16.08.2026: PUT /auth/pin и колонка must_change_pin существовали в API с самого
// начала, но ни один кабинет их не показывал - сотрудник, заведённый владельцем,
// навсегда оставался с временным PIN, который знает тот, кто его заводил. Тогда
// в кабинеты мастера и администратора добавили самостоятельную смену.
//
// 20.08.2026, решение Влада: менять PIN может ТОЛЬКО владелец, и сразу всем.
// Повод - утечка боевых логинов в публичный репозиторий (tools/*.mjs), при
// разборе которой вскрылось главное: у самого владельца формы смены не было
// вовсе. Самостоятельная смена снята, вместо неё PUT /staff/:id/pin с auth:
// 'owner' и поле прямо в карточке сотрудника раздела «Команда».
// Права проверяются отдельно - tests/api.pin-owner-only.test.js.
//
// 28.08.2026 (Окно 72), перед передачей системы заказчику: сам секрет перестал
// быть «PIN из шести цифр» и стал паролем от шести знаков, а поле входа - из
// «Email» превратилось в «Логин». Модель прав не изменилась: задаёт по-прежнему
// только владелец, эти проверки ниже переписаны лишь по названиям и правилу длины.

test('самостоятельной смены пароля у мастера и администратора больше нет', async () => {
  const [master, admin] = await Promise.all([source('crm-master.html'), source('crm-admin.html')]);

  for (const [name, html] of [['мастер', master], ['администратор', admin]]) {
    assert.doesNotMatch(html, /id="pinNew"/, `${name}: поле PIN осталось в разметке`);
    assert.doesNotMatch(html, /id="pinSaveBtn"/, `${name}: кнопка смены осталась`);
    assert.doesNotMatch(html, /crm-pin\.js/, `${name}: модуль самостоятельной смены ещё подключён`);
    // Пустого места быть не должно: человек, который раньше менял PIN сам, обязан
    // узнать со страницы, куда теперь идти, а не гадать, почему форма исчезла
    assert.match(html, /Пароль для входа задаёт владелец/, `${name}: не сказано, кто теперь задаёт пароль`);
  }
});

test('модуль самостоятельной смены удалён, а не оставлен мёртвым', async () => {
  // Файл на диске без подключения - это не «отключено», а забытая копия логики,
  // которая при следующей правке легко вернётся в разметку
  assert.equal(await missing('assets/crm-pin.js'), true, 'assets/crm-pin.js всё ещё лежит в проекте');
  const auth = await source('api/routes/auth.js');
  assert.doesNotMatch(auth, /export async function handlePinChange/, 'обработчик /auth/pin не удалён');
});

test('владелец задаёт пароль прямо в карточке сотрудника', async () => {
  const team = await source('assets/crm-team.js');

  // Секцию рисуем только владельцу: раздел «Сотрудники» у администратора и
  // управляющего собирает этот же код, а роут им ответит 401
  assert.match(team, /viewerRole === 'owner' \? section\('Пароль для входа'/);
  assert.match(team, /class="pin-new" type="password"[^>]*autocomplete="new-password"/, 'поле пароля не закрыто от автозаполнения');
  assert.match(team, /class="pin-repeat" type="password"[^>]*autocomplete="new-password"/, 'повтор пароля не закрыт');
  assert.match(team, /apiSend\(`\/staff\/\$\{staffId\}\/pin`, 'PUT'/, 'форма шлёт не тот роут');
});

test('форма повторяет правило сервера и не оставляет введённое на экране', async () => {
  const [team, staff] = await Promise.all([source('assets/crm-team.js'), source('api/routes/staff.js')]);

  // Сервер принимает пароль от шести знаков - интерфейс обязан сказать об этом
  // заранее, а не отказом после отправки
  assert.match(staff, /export const MIN_SECRET_LENGTH = 6;/);
  assert.match(staff, /export const isValidSecret = \(secret\) =>/);
  assert.match(team, /newPin\.length < 6/);
  assert.match(team, /newPin !== repeatEl\.value\.trim\(\)/);
  // Введённый пароль стирается из полей после успеха: карточка часто открыта на
  // экране в зале
  assert.match(team, /newEl\.value = '';\s*\n\s*repeatEl\.value = '';/);
  // и никуда не логируется
  assert.doesNotMatch(team, /console\.(log|info|warn|error)\([^)]*[Pp]in/);
});

test('временный пароль гасится при задании постоянного', async () => {
  const staff = await source('api/routes/staff.js');
  // must_change_pin ставится в true при заведении сотрудника. Снимала его раньше
  // самостоятельная смена; её больше нет, значит снять флаг может только эта
  // операция - иначе баннер о временном PIN висел бы вечно и снять его было бы нечем
  assert.match(staff, /UPDATE staff SET pin_hash = \$1, must_change_pin = false WHERE id = \$2/);
});

test('смена пароля обрывает прежние входы сотрудника, кроме текущего', async () => {
  const staff = await source('api/routes/staff.js');
  // Интерфейс обещает «войти по старому уже нельзя». Сессия держится на своём
  // токене и живёт 30 дней независимо от пароля, поэтому без этого DELETE
  // обещание было ложным: вкладка, открытая со старым паролем, работала дальше.
  assert.match(staff, /DELETE FROM sessions WHERE staff_id = \$1 AND token <> \$2/,
    'прежние входы не обрываются при смене пароля');
  // Текущую сессию щадим: иначе владелец, задавая пароль себе, выкинул бы себя
  assert.match(staff, /token <> \$2/, 'текущая сессия не исключена - владелец выкинет сам себя');
  // Порядок: сначала пароль записан, потом рвём сессии
  assert.ok(
    staff.indexOf('UPDATE staff SET pin_hash') < staff.indexOf('DELETE FROM sessions WHERE staff_id = $1 AND token'),
    'сессии рвутся раньше, чем записан новый пароль',
  );
});
