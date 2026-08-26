// Проверить заявку на подключение арендатора ДО перезапуска приложения
// (Окно 69, 26.08.2026, plans/2026-08-26-podklyuchenie-arendatora.md).
//
// Зачем. Арендатор заводится переменной NEW_TENANT в панели Amvera плюс
// перезапуском. Перезапуск - операция на живом салоне Алихана, и узнавать из логов,
// что в JSON пропущена запятая, поздно и дорого. Этот скрипт разбирает заявку теми
// же функциями, что и сам сервер, и печатает, что именно будет создано.
//
// В базу не ходит вовсе - подключаться к ней снаружи всё равно нечем.
//
// Запуск:
//   NEW_TENANT='{"name":"...","domains":["crm.example.ru"],...}' node tools/check-new-tenant.mjs
//   node tools/check-new-tenant.mjs заявка.json
import { readFileSync } from 'node:fs';
import { parseTenantSpec, describeTenantSpec, readTenantEnv } from '../api/lib/provision-tenant.js';

const fromFile = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : null;
const raw = fromFile ?? process.env.NEW_TENANT;

if (!raw || !String(raw).trim()) {
  console.error('Заявки нет: задайте NEW_TENANT или укажите файл первым аргументом');
  process.exit(1);
}

// Заявку принимаем и открытым текстом, и уже закодированной: перепроверить то, что
// реально стоит в панели, важнее удобства первого ввода. Отличаем по первому знаку -
// JSON начинается с фигурной скобки, base64 такого символа не содержит вовсе
const trimmed = String(raw).trim();
const source = trimmed.startsWith('{') ? { NEW_TENANT: trimmed } : { NEW_TENANT_B64: trimmed };

let spec;
let json;
try {
  json = readTenantEnv(source);
  spec = parseTenantSpec(json);
} catch (error) {
  console.error(`ЗАЯВКА НЕ ГОДИТСЯ\n${error.message}`);
  console.error('\nПеременную в панель не ставьте: приложение стартует, но арендатора не заведёт');
  process.exit(1);
}

console.log('ЗАЯВКА РАЗОБРАНА. При следующем перезапуске приложения будет создано:\n');
console.log(describeTenantSpec(spec));

// Панель Amvera не принимает кавычки и восклицательный знак (проверено живьём
// 26.08.2026), поэтому заявка едет туда закодированной. Печатаем готовую строку -
// кодировать руками человеку незачем
console.log('\nСтрока для панели Amvera. Имя переменной NEW_TENANT_B64, галочка «Это секрет»:\n');
console.log(Buffer.from(json, 'utf8').toString('base64'));
console.log(`
Дальше по плану окна:
  1. переменная NEW_TENANT_B64 в панель Amvera, перезапуск приложения;
  2. в логе - строка «Арендатор подключён: id=...»;
  3. проверка снаружи: GET /tenant/appearance с Origin ${spec.domains[0]} отвечает 200;
  4. переменную из панели убрать и ПЕРЕЗАПУСТИТЬ - убранная переменная продолжает
     действовать в уже работающем контейнере (найдено живьём на BACKUP_TOKEN 26.08.2026);
  5. вход владельца по временному PIN и смена PIN.`);
