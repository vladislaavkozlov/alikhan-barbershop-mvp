// Выкладка кабинета арендатора в его контур Amvera (28.08.2026, подключение клиники
// Карины Урбашевичус).
//
// Зачем это существует. Сервер узнаёт арендатора по домену запроса, а домен
// vladislaavkozlov.github.io целиком принадлежит Алихану. Значит кабинет второго
// арендатора обязан отдаваться с другого адреса. Соблазнительный и неверный путь -
// завести папку-клон и синхронить её руками: на первой же правке комплекты разъедутся,
// и клиент получит вчерашний кабинет. Здесь копии нет вовсе - файлы каждый раз берутся
// из этого репозитория, а клон контура Amvera существует только как способ доставки,
// его содержимое затирается целиком перед каждой выкладкой.
//
// Что НЕ едет в чужой контур: брендовые картинки Алихана (вензель, герб, локап). Их
// отсутствие - и есть признак «своего логотипа нет»: кабинет тогда пишет название
// заведения текстом, получая его с сервера (assets/crm-app-shell.js, applyBrand).
//
// Запуск:
//   node tools/deploy-cabinet.mjs --project=karinacrm --site=https://karinaurbashevichus.ru \
//        --icons=/Users/user/Desktop/karina-landing
//   ... --dry   печатает план и хэши, ничего не пушит
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SSH_KEY = `${process.env.HOME}/.ssh/amvera_alikhan_deploy`;
const GIT_USER = 'vladislaavkozlov';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);

const project = args.project;
const site = args.site;
const iconsDir = args.icons ? String(args.icons) : null;
const dry = !!args.dry;
if (!project || !site) {
  console.error('Нужны --project=<имя проекта Amvera> и --site=<адрес сайта клиента>');
  process.exit(1);
}

// Состав кабинета. Список явный, а не «всё подряд»: в корне репозитория лежат сайт
// Алихана (index.html), его политика и промпты окон - в чужом контуре им делать нечего.
const FILES = [
  'crm-owner.html', 'crm-admin.html', 'crm-master.html',
  'app.js', 'storage.js', 'sw.js',
  'manifest-owner.webmanifest', 'manifest-admin.webmanifest', 'manifest-master.webmanifest',
];
// Картинки бренда Алихана. Иконки заменяются иконками клиента, если они переданы;
// вензель и герб не заменяются ничем - именно поэтому кабинет покажет название текстом.
const BRAND_SKIP = ['wordmark-header.webp', 'crest-hero.webp', 'lockup-footer.webp'];
const ICON_MAP = {
  'favicon.ico': 'favicon.ico',
  'apple-touch-icon-180.png': 'apple-touch-icon.png',
  'icon-48.png': 'favicon-32.png',
  'icon-96.png': 'favicon-96.png',
  'icon-192.png': 'icon-192.png',
  'icon-512.png': 'icon-512.png',
};

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

const git = (cwd, ...argv) =>
  execFileSync('git', argv, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o BatchMode=yes` },
  });

const work = mkdtempSync(join(tmpdir(), 'cabinet-'));
const clone = join(work, project);
console.log(`Контур: git@git.msk0.amvera.ru:${GIT_USER}/${project}.git`);
git(work, 'clone', `git@git.msk0.amvera.ru:${GIT_USER}/${project}.git`, clone);

// Затираем контур целиком: выложенное вчера не должно пережить сегодняшнюю выкладку.
// Так исключается третье состояние «файл удалён из репозитория, но живёт у клиента».
for (const entry of readdirSync(clone)) {
  if (entry !== '.git') rmSync(join(clone, entry), { recursive: true, force: true });
}

for (const file of FILES) cpSync(join(ROOT, file), join(clone, file));
cpSync(join(ROOT, 'assets'), join(clone, 'assets'), {
  recursive: true,
  filter: (src) => !BRAND_SKIP.some((skip) => src.endsWith(`/brand/${skip}`)),
});

// Иконки клиента под именами, которые ждёт кабинет: свои файлы вместо герба Алихана
if (iconsDir) {
  for (const [target, source] of Object.entries(ICON_MAP)) {
    const from = join(iconsDir, source);
    if (existsSync(from)) cpSync(from, join(clone, 'assets', 'brand', target));
    else console.log(`  иконка ${source} у клиента не найдена - в контур не поехала`);
  }
}

// Ссылка «на сайт» в шапке кабинета ведёт на index.html - в контуре клиента это его
// собственный сайт, а не сайт Алихана
writeFileSync(join(clone, 'index.html'), `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Кабинет</title>
<meta http-equiv="refresh" content="0; url=${site}">
<link rel="canonical" href="${site}">
<meta name="robots" content="noindex">
</head>
<body>
<p>Сайт: <a href="${site}">${site}</a></p>
<p>Кабинет сотрудников: <a href="crm-owner.html">войти</a></p>
</body>
</html>
`);

writeFileSync(join(clone, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

writeFileSync(join(clone, 'nginx.conf'), `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 512;
    gzip_types text/plain text/css application/javascript image/svg+xml application/json;

    # Разметка и скрипты кабинета не кэшируются: правка обязана доезжать до сотрудника
    # сразу, иначе половина смены работает во вчерашней версии
    # Разметка, скрипты и СТИЛИ не кэшируются. Стили сюда добавлены 28.08.2026 после
    # прямой поимки: правка вёрстки уехала в контур, а браузер неделю показывал бы
    # старый файл - у сотрудника это выглядит как «исправление не работает»
    location ~* \\.(html|js|css|webmanifest)$ {
        add_header Cache-Control "no-cache";
    }
    location ~* \\.(jpg|jpeg|png|webp|svg|ico|woff2)$ {
        expires 7d;
        add_header Cache-Control "public";
    }
    location / {
        try_files $uri $uri/ =404;
    }
}
`);

writeFileSync(join(clone, 'Dockerfile'), `# Статическая раздача кабинета арендатора через nginx.
# Собирается из файлов, выложенных скриптом tools/deploy-cabinet.mjs репозитория CRM -
# руками здесь ничего не правится, правка потеряется при следующей выкладке.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html/
RUN rm -f /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/nginx.conf /usr/share/nginx/html/amvera.yml

EXPOSE 80
`);

writeFileSync(join(clone, 'amvera.yml'), `meta:
  environment: docker
  toolchain:
    name: docker

build:
  dockerfile: Dockerfile

run:
  containerPort: 80
`);

// Сверка: то, что уехало в контур, обязано побайтно совпадать с репозиторием. Это и
// есть защита от разъезда версий - не обещание, а проверка на каждой выкладке.
const drift = [];
for (const file of FILES) {
  if (sha(join(ROOT, file)) !== sha(join(clone, file))) drift.push(file);
}
for (const rel of listFiles(join(ROOT, 'assets'))) {
  if (BRAND_SKIP.some((skip) => rel.endsWith(`brand/${skip}`))) continue;
  const target = join(clone, 'assets', rel);
  const isIcon = rel.startsWith('brand/') && Object.keys(ICON_MAP).includes(rel.slice('brand/'.length));
  if (isIcon && iconsDir) continue; // иконки намеренно заменены на клиентские
  if (!existsSync(target) || sha(join(ROOT, 'assets', rel)) !== sha(target)) drift.push(`assets/${rel}`);
}
if (drift.length) {
  console.error(`\nВЫКЛАДКА ОСТАНОВЛЕНА. Файлы в контуре не совпали с репозиторием:\n  ${drift.join('\n  ')}`);
  process.exit(1);
}

const count = listFiles(clone).filter((f) => !f.startsWith('.git/')).length;
console.log(`Собрано файлов: ${count}. Расхождений с репозиторием: 0`);
console.log(`Кабинеты: crm-owner.html, crm-admin.html, crm-master.html`);
console.log(`Ссылка «на сайт»: ${site}`);

if (dry) {
  console.log(`\n--dry: контур подготовлен в ${clone}, пуша не было`);
  process.exit(0);
}

const head = git(ROOT, 'rev-parse', '--short', 'HEAD').trim();
git(clone, 'add', '-A');
const status = git(clone, 'status', '--porcelain').trim();
if (!status) {
  console.log('\nВ контуре и так лежит ровно это - коммита нет, пересборка не нужна');
  process.exit(0);
}
git(clone, '-c', 'user.email=deploy@local', '-c', 'user.name=cabinet-deploy',
  'commit', '-m', `Кабинет из репозитория CRM (${head})`);
// Amvera следит за веткой master (память reference_amvera-deploy-gotchas)
git(clone, 'branch', '-M', 'master');
git(clone, 'push', '-u', 'origin', 'master');
console.log(`\nВыложено. Пересборка Amvera стартует сама, обычно 30-90 секунд`);
console.log(`Адрес: https://${project}-${GIT_USER}.amvera.io/crm-owner.html`);
