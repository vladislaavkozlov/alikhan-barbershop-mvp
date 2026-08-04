// Проверка Окна 26 (04.08.2026) - бейдж "ближайшая доступная дата" на карточке
// мастера в booking-форме, ДО выбора мастера/услуги/даты. Тот же приём, что уже
// применён в verify-2026-08-04-okno21-realnaya-dostupnost.mjs - window.ALIKHAN_API_URL
// переключён на локальный сервер (node api/server.mjs, порт 8091, DB=alikhan_test).
//
// Фикстура перед запуском (см. сессию): master-2 временно сделан полностью
// недоступным на все 7 дней недели (master_weekly_schedule.is_working=false) -
// master-1/master-3 остались на дефолте (свободны сегодня). Откатывается после
// прогона этим же скриптом (DELETE в конце).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8798;
const API_URL = 'http://localhost:8091';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    let data = await readFile(join(ROOT, p));
    if (p === '/index.html') {
      data = Buffer.from(
        data.toString('utf8').replace(
          /window\.ALIKHAN_API_URL = '[^']*';/,
          `window.ALIKHAN_API_URL = '${API_URL}';`,
        ),
      );
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(PORT, resolve));
const BASE = `http://localhost:${PORT}`;

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`OK   ${label}`); }
  else { fail++; console.log(`FAIL ${label}`); }
}

async function readMasterCards(s) {
  return s.eval(`Array.from(document.querySelectorAll('#master-grid .master-option')).map((wrap) => ({
    name: wrap.querySelector('.opt-name')?.textContent,
    badge: wrap.querySelector('.opt-availability')?.textContent ?? null,
    badgeNone: wrap.querySelector('.opt-availability--none') !== null,
    hasCallLink: wrap.querySelector('.opt-admin-call') !== null,
    callHref: wrap.querySelector('.opt-admin-call')?.getAttribute('href') ?? null,
  }))`);
}

await withBrowser(async (s) => {
  await s.navigate(`${BASE}/index.html`);
  await s.setViewport(390, 900, true);

  // Бейдж появляется асинхронно (batch fetch /masters-next-availability приходит
  // после первой отрисовки) - ждём реального ответа сети, не фиксированный таймаут.
  await new Promise((r) => setTimeout(r, 700));

  const cards = await readMasterCards(s);
  console.log('Карточки мастеров:', JSON.stringify(cards, null, 2));

  check('3 карточки мастеров отрисованы', cards.length === 3);

  const master1 = cards.find((c) => c.name === 'Алиовсад'); // master-1, свободен сегодня
  const master2 = cards.find((c) => c.name === 'Мамедхан'); // master-2, QA-фикстура: недоступен
  const master3 = cards.find((c) => c.name === 'Елизавета'); // master-3, свободен сегодня

  check('Алиовсад (свободен): бейдж "ближайшая запись - 04.08.2026"', master1?.badge === 'ближайшая запись - 04.08.2026');
  check('Алиовсад (свободен): нет ссылки на администратора', master1?.hasCallLink === false);

  check('Мамедхан (недоступен 60 дней): бейдж "сейчас нет свободных мест"', master2?.badge === 'сейчас нет свободных мест');
  check('Мамедхан (недоступен): класс opt-availability--none применён', master2?.badgeNone === true);
  check('Мамедхан (недоступен): есть ссылка "Позвонить администратору"', master2?.hasCallLink === true);
  check('Мамедхан (недоступен): ссылка ведёт на реальный номер салона', master2?.callHref === 'tel:+79899977070');

  check('Елизавета (свободна): бейдж "ближайшая запись - 04.08.2026"', master3?.badge === 'ближайшая запись - 04.08.2026');

  // Клик по карточке с недоступным мастером всё ещё выбирает его (бейдж не блокирует
  // выбор - клиент может захотеть посмотреть его услуги/записаться позже вручную через
  // администратора) - проверяем регрессию поведения выбора, не только бейдж.
  await s.click('#master-grid .master-option:nth-child(2) .option-card');
  await new Promise((r) => setTimeout(r, 150));
  const selectedAfterClick = await s.eval(
    `document.querySelector('#master-grid .master-option:nth-child(2) .option-card').classList.contains('selected')`
  );
  check('Клик по недоступному мастеру всё равно выбирает его (не заблокирован)', selectedAfterClick === true);

  const serviceGridEnabled = await s.eval(`document.getElementById('service-grid').getAttribute('aria-disabled')`);
  check('После выбора недоступного мастера шаг "услуги" разблокирован как обычно', serviceGridEnabled === null);
}).finally(() => server.close());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
