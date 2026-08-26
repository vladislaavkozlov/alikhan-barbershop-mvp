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
import { parseTenantSpec, describeTenantSpec } from '../api/lib/provision-tenant.js';

const fromFile = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : null;
const raw = fromFile ?? process.env.NEW_TENANT;

if (!raw || !String(raw).trim()) {
  console.error('Заявки нет: задайте NEW_TENANT или укажите файл первым аргументом');
  process.exit(1);
}

let spec;
try {
  spec = parseTenantSpec(raw);
} catch (error) {
  console.error(`ЗАЯВКА НЕ ГОДИТСЯ\n${error.message}`);
  console.error('\nПеременную в панель не ставьте: приложение стартует, но арендатора не заведёт');
  process.exit(1);
}

console.log('ЗАЯВКА РАЗОБРАНА. При следующем перезапуске приложения будет создано:\n');
console.log(describeTenantSpec(spec));
console.log(`
Дальше по плану окна:
  1. переменная NEW_TENANT в панель Amvera, перезапуск приложения;
  2. в логе - строка «Арендатор подключён: id=...»;
  3. проверка снаружи: GET /tenant/appearance с Origin ${spec.domains[0]} отвечает 200;
  4. переменную из панели убрать и ПЕРЕЗАПУСТИТЬ - убранная переменная продолжает
     действовать в уже работающем контейнере (найдено живьём на BACKUP_TOKEN 26.08.2026);
  5. вход владельца по временному PIN и смена PIN.`);
