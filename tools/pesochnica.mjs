// Кабинет-песочница на этой машине (31.08.2026, просьба Влада «нужен контур, где
// можно посмотреть изменения и поэкспериментировать»).
//
// Что это. Тот же самый кабинет и тот же самый боевой сервер, но данные - отдельного
// арендатора «Песочница»: свои сотрудники, услуги, записи, клиенты. Замок из миграции
// 058 не даёт этому арендатору увидеть ни строки Алихана или Карины, а им - его.
// Ломать здесь можно что угодно: живых денег за этими записями нет.
//
// Почему адрес локальный. Арендатора система узнаёт по домену страницы, а бесплатного
// домена под третий кабинет у нас нет: и Алихан, и Карина стоят на своих. Поэтому
// песочница живёт на этой машине по адресу http://localhost:8793 - он и записан
// доменом арендатора. Открывается только здесь, с телефона в неё не зайти; когда
// понадобится адрес снаружи, это отдельный платный контур.
//
// Запуск:
//   node tools/pesochnica.mjs
// Остановить - Ctrl+C в этом же окне терминала.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = 8793;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // normalize + отсечение выхода наверх: сервер отдаёт только файлы проекта
  const rel = normalize(path === '/' ? '/crm-owner.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Нельзя');
    return;
  }
  try {
    const body = await readFile(file);
    // Кабинет статикой не кэшируется: песочница нужна как раз чтобы видеть свежую
    // правку сразу, без охоты за старым файлом в кэше браузера
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Нет такого файла');
  }
}).listen(PORT, () => {
  console.log(`
Песочница поднята.

  Кабинет владельца:  http://localhost:${PORT}/crm-owner.html
  Кабинет админа:     http://localhost:${PORT}/crm-admin.html
  Кабинет сотрудника: http://localhost:${PORT}/crm-master.html
  Сайт записи:        http://localhost:${PORT}/index.html

  Вход:  логин demo,  пароль 246810 (при первом входе система попросит задать свой)

Данные отдельные, к Алихану и Карине отсюда доступа нет. Останавливается Ctrl+C
`);
});
