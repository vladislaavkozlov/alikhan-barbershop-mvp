// Задача E промпта Окна 29 (05.08.2026) - общая инфраструктура для автономных
// verify-скриптов. Проблема, которую чинит этот файл: старые прогоны (okno21/23/26)
// требовали ВНЕШНЕ поднятого `node api/server.mjs` на конкретном порту против общей
// alikhan_test и ВРУЧНУЮ заведённых QA-фикстур/аккаунтов из чужой сессии - в чужом
// окне (или на следующий день) это красило прогон в FAIL по причине "фикстуры нет",
// что читается как регресс кода, хотя механизм цел (см. reference_barbershop-crm-tech.md,
// разбор аудита окон 21-28). Теперь каждый прогон поднимает СВОЮ одноразовую базу и
// СВОЙ процесс сервера на эфемерном порту, сам сеет нужные фикстуры и сам их/всю базу
// убирает - зелёный «из коробки» без ручной подготовки, независимо от чужих сессий.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, scryptSync } from 'node:crypto';
import pg from 'pg';

const execFileP = promisify(execFile);

// Тот же алгоритм, что hashPin() в api/server.mjs (scrypt, 64-байтный хэш, формат
// "salt:hash") - свой случайный PIN на прогон, не литерал в публичном репозитории
// (см. [[feedback_hardkodit-pin-fikstury-protiv-boevogo-api]]).
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function randomPin() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

// today+offsetDays как 'YYYY-MM-DD' - фикстуры дат строятся ОТНОСИТЕЛЬНО дня запуска,
// не хардкодятся литералом (иначе назавтра "далеко в будущем" перестаёт быть таковым
// или пересекается с реальными данными - тот же урок, что уже поймал аудит 05.08).
export function daysFromToday(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Поднимает одноразовую Postgres-базу (createdb) + свой server.mjs на свободном
// порту, ждёт /health=200, отдаёт { apiUrl, db } в fn, в finally гасит сервер и
// dropdb - независимо от того, упал ли fn. db - открытый pg.Client на ту же базу,
// для прямого INSERT/DELETE фикстур, которые не выразить публичным API (например
// сами QA-аккаунты - staff не создаётся через REST, только миграциями).
export async function withEphemeralServer(fn) {
  const dbName = `alikhan_verify_${randomBytes(4).toString('hex')}`;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const apiUrl = `http://localhost:${port}`;

  await execFileP('createdb', [dbName]);

  const proc = spawn('node', ['api/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      DB_NAME: dbName,
      DB_USER: process.env.USER,
      DB_PASSWORD: '',
      PORT: String(port),
      ALLOWED_ORIGIN: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupLog = '';
  proc.stdout.on('data', (d) => { startupLog += d.toString(); });
  proc.stderr.on('data', (d) => { startupLog += d.toString(); });

  let db;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        const res = await fetch(`${apiUrl}/health`);
        if (res.ok) { ready = true; break; }
      } catch {}
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) {
      throw new Error(`сервер на ${apiUrl} не поднялся за отведённое время (или упал):\n${startupLog}`);
    }

    db = new pg.Client({
      host: 'localhost', port: 5432, database: dbName, user: process.env.USER,
      ssl: { rejectUnauthorized: false },
    });
    await db.connect();

    return await fn({ apiUrl, dbName, db });
  } finally {
    if (db) await db.end().catch(() => {});
    proc.kill();
    await new Promise((r) => setTimeout(r, 200));
    await execFileP('dropdb', [dbName]).catch((e) => {
      console.error(`не удалось dropdb ${dbName} (осталась висеть, убрать вручную): ${e.message}`);
    });
  }
}

// Мини-сервер статики (тот же приём, что уже был в okno21/23/26) - раздаёт корень
// проекта, подменяя window.ALIKHAN_API_URL на переданный apiUrl во всех *.html.
export async function withStaticServer(apiUrl, fn) {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { extname, join } = await import('node:path');
  const ROOT = process.cwd();
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

  const server = createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    try {
      let data = await readFile(join(ROOT, p));
      if (p.endsWith('.html')) {
        // Кавычки любые (20.08.2026): редизайн лендинга 18.08 переписал строку с
        // одинарных кавычек на двойные, регулярка перестала совпадать - и КАЖДЫЙ
        // прогон, открывавший index.html через этот сервер, молча работал против
        // БОЕВОГО бэкенда на Amvera вместо эфемерной базы. Ошибка тихая: страница
        // выглядит рабочей, прогон «зелёный», а записи уезжают в прод. Поэтому ниже
        // ещё и жёсткая проверка результата - лучше упасть, чем снова не заметить.
        const html = data.toString('utf8').replace(
          /window\.ALIKHAN_API_URL\s*=\s*["'][^"']*["'];/,
          `window.ALIKHAN_API_URL = '${apiUrl}';`
        );
        if (/ALIKHAN_API_URL/.test(html) && !html.includes(`window.ALIKHAN_API_URL = '${apiUrl}';`)) {
          res.writeHead(500);
          res.end('static server: не удалось подменить ALIKHAN_API_URL - страница ушла бы в прод');
          return;
        }
        data = Buffer.from(html);
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  await new Promise((resolve) => server.listen(port, resolve));
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    server.close();
  }
}

export function makeChecker() {
  let pass = 0;
  let fail = 0;
  const failures = [];
  function check(label, cond, extra = '') {
    if (cond) { pass++; console.log(`OK   ${label}`); }
    else { fail++; failures.push(label); console.log(`FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
  }
  function summary() {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) console.log('Провалено:', failures.join('; '));
    return fail === 0;
  }
  return { check, summary, get pass() { return pass; }, get fail() { return fail; } };
}
