// Окно 69, фаза 1 (26.08.2026, plans/2026-08-26-podklyuchenie-arendatora.md).
// Разбор переменной NEW_TENANT: из неё рождаются арендатор, его первый владелец и
// его PIN, поэтому проверка заявки - не формальность, а замок. Тесты написаны ДО
// кода и держат обещания фазы:
//   - молча ничего не додумывается: незнакомый ключ, кривой домен, кривая почта -
//     отказ с понятным текстом, а не «примерно понял»;
//   - домен приходит уже нормализованным. Ошибка здесь стоит дороже всего: домен
//     определяет арендатора, и опечатка означает «Карина видит кабинет Алихана»
//     либо 404 у реального клиента;
//   - PIN, если задан, проходит ту же проверку, что и в кабинете (6 цифр);
//   - описание заявки не печатает PIN: им обычно и пользуются, чтобы секрет НЕ
//     уехал в лог приложения.
// Настоящий Postgres здесь не нужен: это чистые функции.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTenantSpec, describeTenantSpec, TenantSpecError } from '../api/lib/provision-tenant.js';

const VALID = JSON.stringify({
  name: 'Урбашевичус - клиника авторской ортодонтии',
  domains: ['crm.karinaurbashevichus.ru'],
  vertical: 'clinic',
  owner: { name: 'Карина Урбашевичус', email: 'karina@urbashevichus.ru', pin: '482913' },
  services: [
    { name: 'Консультация', durationMin: 30, price: 0 },
    { name: 'Повторный сеанс', durationMin: 30, price: 0 },
  ],
});

const withOwner = (owner) => JSON.stringify({ name: 'Клиника', domains: ['crm.example.ru'], vertical: 'clinic', owner });
const withDomains = (domains) => JSON.stringify({ name: 'Клиника', domains, vertical: 'clinic', owner: { name: 'К', email: 'k@example.ru' } });
const withServices = (services) => JSON.stringify({ name: 'Клиника', domains: ['crm.example.ru'], vertical: 'clinic', owner: { name: 'К', email: 'k@example.ru' }, services });

test('заявка Карины разбирается целиком', () => {
  const spec = parseTenantSpec(VALID);
  assert.equal(spec.name, 'Урбашевичус - клиника авторской ортодонтии');
  assert.deepEqual(spec.domains, ['crm.karinaurbashevichus.ru']);
  assert.equal(spec.vertical, 'clinic');
  assert.equal(spec.owner.email, 'karina@urbashevichus.ru');
  assert.equal(spec.owner.pin, '482913');
  assert.equal(spec.services.length, 2);
  assert.equal(spec.services[0].name, 'Консультация');
  assert.equal(spec.services[0].durationMin, 30);
  assert.equal(spec.services[0].price, 0);
  // Категория зарплаты у процедуры по умолчанию базовая - CHECK в схеме знает только
  // 'base' и 'complex', и выдумывать третью нельзя
  assert.equal(spec.services[0].category, 'base');
});

test('владелец по умолчанию принимает клиентов - иначе кабинет встретит его расписанием без единого врача', () => {
  const spec = parseTenantSpec(withOwner({ name: 'К', email: 'k@example.ru' }));
  assert.equal(spec.owner.providesServices, true);
  const off = parseTenantSpec(withOwner({ name: 'К', email: 'k@example.ru', providesServices: false }));
  assert.equal(off.owner.providesServices, false);
});

test('пустая или отсутствующая переменная - это «заводить некого», а не ошибка', () => {
  assert.equal(parseTenantSpec(undefined), null);
  assert.equal(parseTenantSpec(''), null);
  assert.equal(parseTenantSpec('   '), null);
});

test('битый JSON отвергается с понятным текстом', () => {
  assert.throws(() => parseTenantSpec('{name: Клиника}'), TenantSpecError);
  assert.throws(() => parseTenantSpec('[]'), /объект/);
  assert.throws(() => parseTenantSpec('"строка"'), /объект/);
});

test('незнакомый ключ - отказ, а не молчаливый пропуск', () => {
  const raw = JSON.stringify({ name: 'Клиника', domains: ['crm.example.ru'], vertical: 'clinic', owner: { name: 'К', email: 'k@example.ru' }, theme: 'dark' });
  assert.throws(() => parseTenantSpec(raw), /theme/);
  assert.throws(() => parseTenantSpec(withOwner({ name: 'К', email: 'k@example.ru', role: 'admin' })), /role/);
  assert.throws(() => parseTenantSpec(withServices([{ name: 'Консультация', durationMin: 30, price: 0, discount: 10 }])), /discount/);
});

test('имя обязательно и непустое', () => {
  assert.throws(() => parseTenantSpec(JSON.stringify({ domains: ['crm.example.ru'], vertical: 'clinic', owner: { name: 'К', email: 'k@example.ru' } })), /name/);
  assert.throws(() => parseTenantSpec(JSON.stringify({ name: '   ', domains: ['crm.example.ru'], vertical: 'clinic', owner: { name: 'К', email: 'k@example.ru' } })), /name/);
});

test('домен обязан приехать голым и латиницей', () => {
  // Схема, слэш, регистр - всё это молча «поправить» нельзя: поправленный домен
  // может оказаться не тем, который человек имел в виду
  assert.throws(() => parseTenantSpec(withDomains(['https://crm.example.ru'])), /домен/i);
  assert.throws(() => parseTenantSpec(withDomains(['crm.example.ru/kabinet'])), /домен/i);
  assert.throws(() => parseTenantSpec(withDomains(['CRM.Example.RU'])), /домен/i);
  // Кириллица в домене - самая правдоподобная опечатка: «с» и «е» в раскладке рядом
  assert.throws(() => parseTenantSpec(withDomains(['сrm.example.ru'])), /домен/i);
  assert.throws(() => parseTenantSpec(withDomains([])), /домен/i);
  assert.throws(() => parseTenantSpec(withDomains(['crm.example.ru', 'crm.example.ru'])), /дважды|повтор/i);
});

test('вертикаль - только та, для которой есть словарь', () => {
  assert.throws(() => parseTenantSpec(JSON.stringify({ name: 'Клиника', domains: ['crm.example.ru'], vertical: 'dentistry', owner: { name: 'К', email: 'k@example.ru' } })), /вертикал/i);
  assert.equal(parseTenantSpec(withDomains(['crm.example.ru'])).vertical, 'clinic');
});

test('почта владельца проверяется той же функцией, что и в кабинете', () => {
  assert.throws(() => parseTenantSpec(withOwner({ name: 'К', email: 'karina' })), /почт|email/i);
  assert.throws(() => parseTenantSpec(withOwner({ name: 'К' })), /почт|email/i);
  assert.throws(() => parseTenantSpec(withOwner({ email: 'k@example.ru' })), /имя|name/i);
  // Почта приводится к нижнему регистру - вход ищет сотрудника именно так
  assert.equal(parseTenantSpec(withOwner({ name: 'К', email: 'Karina@Urbashevichus.RU' })).owner.email, 'karina@urbashevichus.ru');
});

test('PIN необязателен, но заданный проходит проверку кабинета - 6 цифр', () => {
  assert.equal(parseTenantSpec(withOwner({ name: 'К', email: 'k@example.ru' })).owner.pin, null);
  assert.throws(() => parseTenantSpec(withOwner({ name: 'К', email: 'k@example.ru', pin: '48291' })), /pin/i);
  assert.throws(() => parseTenantSpec(withOwner({ name: 'К', email: 'k@example.ru', pin: '4829a3' })), /pin/i);
  assert.throws(() => parseTenantSpec(withOwner({ name: 'К', email: 'k@example.ru', pin: 482913 })), /pin/i);
});

test('процедуры: имя, целая положительная длительность, неотрицательная цена', () => {
  assert.deepEqual(parseTenantSpec(withServices(undefined)).services, []);
  assert.throws(() => parseTenantSpec(withServices([{ name: '', durationMin: 30, price: 0 }])), /процедур/i);
  assert.throws(() => parseTenantSpec(withServices([{ name: 'Консультация', durationMin: 0, price: 0 }])), /длительн/i);
  assert.throws(() => parseTenantSpec(withServices([{ name: 'Консультация', durationMin: 30.5, price: 0 }])), /длительн/i);
  assert.throws(() => parseTenantSpec(withServices([{ name: 'Консультация', durationMin: 30, price: -1 }])), /цен/i);
  assert.throws(() => parseTenantSpec(withServices([{ name: 'Консультация', durationMin: 30 }])), /цен/i);
  assert.throws(() => parseTenantSpec(withServices([{ name: 'Консультация', durationMin: 30, price: 0, category: 'vip' }])), /категор/i);
});

test('флаги разделов - только известные ключи и только настоящие true/false', () => {
  const raw = (modules) => JSON.stringify({ name: 'Клиника', domains: ['crm.example.ru'], vertical: 'clinic', owner: { name: 'К', email: 'k@example.ru' }, modules });
  assert.deepEqual(parseTenantSpec(raw(undefined)).modules, {});
  assert.deepEqual(parseTenantSpec(raw({ payroll: false })).modules, { payroll: false });
  assert.throws(() => parseTenantSpec(raw({ ortho: true })), /ortho/);
  assert.throws(() => parseTenantSpec(raw({ payroll: 'да' })), /payroll/);
});

test('описание заявки показывает, что будет создано, и НЕ печатает PIN', () => {
  const text = describeTenantSpec(parseTenantSpec(VALID));
  assert.match(text, /Урбашевичус/);
  assert.match(text, /crm\.karinaurbashevichus\.ru/);
  assert.match(text, /karina@urbashevichus\.ru/);
  assert.match(text, /Консультация/);
  assert.match(text, /Повторный сеанс/);
  assert.doesNotMatch(text, /482913/);
});
