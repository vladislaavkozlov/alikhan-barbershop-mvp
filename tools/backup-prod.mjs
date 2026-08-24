// Снять резервную копию боевой базы себе на диск (24.08.2026).
//
// База Amvera недоступна снаружи, копию отдаёт само приложение (GET /backup).
// Роут выключен, пока в панели не задан BACKUP_TOKEN - на время снятия копии его
// включают, потом можно выключить обратно.
//
// Запуск:
//   BACKUP_TOKEN=<секрет из панели> node tools/backup-prod.mjs [папка]
// По умолчанию кладёт в ~/Desktop/alikhan-backups/alikhan-YYYY-MM-DD-HHMM.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const API = process.env.API_URL ?? 'https://alikhancrm1-vladislaavkozlov.amvera.io';
const ORIGIN = process.env.ORIGIN ?? 'https://vladislaavkozlov.github.io';
const EMAIL = process.env.OWNER_EMAIL ?? 'master1-test@alikhan.test';
const PIN = process.env.OWNER_PIN ?? '4495';
const TOKEN = process.env.BACKUP_TOKEN;
const OUT_DIR = process.argv[2] ?? join(homedir(), 'Desktop', 'alikhan-backups');

if (!TOKEN) {
  console.error('Нужен секрет: BACKUP_TOKEN=<значение из панели Amvera> node tools/backup-prod.mjs');
  process.exit(1);
}

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ email: EMAIL, pin: PIN }),
});
if (!login.ok) {
  console.error('Вход владельца не прошёл:', login.status, await login.text());
  process.exit(1);
}
const { token } = await login.json();

const res = await fetch(`${API}/backup`, {
  headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, 'X-Backup-Token': TOKEN },
});
if (!res.ok) {
  console.error(
    `Копия не снята: ${res.status}. 404 здесь означает «секрет не совпал или роут выключен» -`,
    'проверьте BACKUP_TOKEN в панели Amvera'
  );
  process.exit(1);
}
const dump = await res.json();

// Копия без строк - это не копия. Лучше громко упасть, чем положить на диск пустышку
const total = Object.values(dump.rowCount ?? {}).reduce((a, b) => a + b, 0);
if (!total) {
  console.error('В копии нет ни одной строки - это не похоже на боевую базу, файл не сохранён');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const file = join(OUT_DIR, `alikhan-${stamp}.json`);
writeFileSync(file, JSON.stringify(dump, null, 1));

console.log(`Копия снята: ${file}`);
console.log(`Снимок от ${dump.takenAt}, строк всего: ${total}`);
for (const [table, n] of Object.entries(dump.rowCount).filter(([, n]) => n > 0)) {
  console.log(`  ${table}: ${n}`);
}
