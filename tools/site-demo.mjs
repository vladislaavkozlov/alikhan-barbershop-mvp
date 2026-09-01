// Локальная копия сайта клиента с формой записи, развёрнутой на локальный контур
// (01.09.2026).
//
// Зачем. Проверять форму на боевом сайте нельзя: каждая проба оставляет живую
// запись и живого пациента в базе клиники, которых потом нечем убрать. Здесь тот
// же самый файл сайта - не копия, а он сам с диска - но адрес API и ключ заведения
// подменяются на лету, поэтому записи уходят в демо-базу.
//
// Запуск (рядом с bot-demo-local.mjs и локальным API на 8794):
//   node tools/site-demo.mjs
// Открыть http://localhost:8799
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { homedir } from 'node:os';

const SITE_ROOT = process.env.SITE_ROOT || join(homedir(), 'Desktop', 'karina-landing');
const PORT = 8799;
const PROD_API = 'https://alikhancrm1-vladislaavkozlov.amvera.io';
const LOCAL_API = process.env.LOCAL_API || 'http://localhost:8794';
const LOCAL_TENANT = process.env.LOCAL_TENANT || 'demo';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(SITE_ROOT, rel);
  if (!file.startsWith(SITE_ROOT)) {
    res.writeHead(403).end('Нельзя');
    return;
  }
  try {
    let body = await readFile(file);
    if (extname(file) === '.html') {
      // Разворот на локальный контур живёт только в этом ответе: файлы на диске
      // не трогаются, поэтому сайт нельзя случайно опубликовать с localhost внутри
      body = Buffer.from(String(body).split(PROD_API).join(LOCAL_API).replace(/data-tenant="[^"]*"/, `data-tenant="${LOCAL_TENANT}"`));
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Нет такого файла');
  }
}).listen(PORT, () => {
  console.log(`\nСайт клиники с формой записи: http://localhost:${PORT}`);
  console.log(`  API: ${LOCAL_API} · заведение: ${LOCAL_TENANT}`);
  console.log('  Записи уходят в демо-базу, боевая клиника не затрагивается');
  console.log('  Остановить - Ctrl+C\n');
});
