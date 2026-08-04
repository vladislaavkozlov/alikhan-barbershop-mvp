// Проверка Окна 20 (04.08.2026) - лимит публичной записи 60 дней вперёд в календаре
// (renderCalendar/calNext, app.js). Офлайн-демо режим (window.ALIKHAN_API_URL вырезан
// из отдаваемого index.html этим сервером) - календарь не зависит от бэкенда, реальный
// прод Amvera не трогаем, тот же принцип что verify-2026-08-03-grafik-raboty.mjs
// (мок вместо реальной сети). CRM (crm-*.html) не участвует - вне контракта этого окна.
//
// app.js подключён как <script type="module"> - calViewYear/calViewMonth/selectedDate
// живут в module scope, недоступны из window через CDP Runtime.evaluate. Поэтому
// проверка идёт через DOM: data-iso на каждой кнопке дня (добавлен этой же правкой)
// и видимый текст date-toggle-label, а не через module-internals.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = process.cwd();
const PORT = 8798;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  try {
    let data = await readFile(join(ROOT, p));
    if (p === '/index.html') {
      data = Buffer.from(
        data.toString('utf8').replace(
          /window\.ALIKHAN_API_URL = '[^']*';/,
          '// ALIKHAN_API_URL вырезан для офлайн-теста календаря',
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

await withBrowser(async (s) => {
  await s.navigate(`${BASE}/index.html`);
  await s.setViewport(390, 900, true);
  await new Promise((r) => setTimeout(r, 300));

  // выбрать первого мастера, чтобы открыть доступ к date-toggle
  await s.click('#master-grid .option-card');
  await new Promise((r) => setTimeout(r, 150));
  await s.click('#date-toggle');
  await new Promise((r) => setTimeout(r, 150));

  const maxIso = await s.eval(`(function(){
    const d = new Date();
    d.setDate(d.getDate() + 60);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  })()`);

  function isoOfFirstDay(states) {
    return states.length ? states[0].iso.slice(0, 7) : null;
  }

  async function readDayStates() {
    return s.eval(`Array.from(document.querySelectorAll('#cal-grid .cal-day')).map((b) => ({
      iso: b.dataset.iso,
      disabled: b.disabled,
    }))`);
  }

  // долистать calNext до упора (при 60 днях - максимум 2-3 месяца вперёд)
  let clicks = 0;
  while (clicks < 10) {
    const disabled = await s.eval(`document.getElementById('cal-next').disabled`);
    if (disabled) break;
    await s.click('#cal-next');
    await new Promise((r) => setTimeout(r, 80));
    clicks++;
  }

  const nextDisabledAtEnd = await s.eval(`document.getElementById('cal-next').disabled`);
  check('calNext дизейблен на границе 60 дней', nextDisabledAtEnd === true);
  check('дошли до месяца границы за разумное число кликов (<10)', clicks < 10);

  const dayStates = await readDayStates();
  const viewedMonth = isoOfFirstDay(dayStates.filter((d) => d.iso));
  check(`последний доступный месяц совпадает с today+60 (${maxIso.slice(0, 7)})`, viewedMonth === maxIso.slice(0, 7));

  const hintVisible = await s.eval(`!document.getElementById('cal-limit-hint').hidden`);
  check('текст-подсказка "Запись открыта на 60 дней вперёд" показан на границе', hintVisible);

  const hintText = await s.eval(`document.getElementById('cal-limit-hint').textContent`);
  check('текст подсказки читаем и корректен', hintText.includes('60 дней'));

  const withIso = dayStates.filter((d) => d.iso);
  const afterMax = withIso.filter((d) => d.iso > maxIso);
  const atOrBeforeMax = withIso.filter((d) => d.iso <= maxIso);
  check('дни после границы 60 дней задизейблены индивидуально', afterMax.length > 0 && afterMax.every((d) => d.disabled === true));
  const atMax = withIso.find((d) => d.iso === maxIso);
  check('день ровно на границе (today+60) НЕ задизейблен', atMax ? atMax.disabled === false : true);
  check(
    'дни до границы (кроме самой границы) не затронуты',
    atOrBeforeMax.filter((d) => d.iso !== maxIso).every((d) => d.disabled === false),
  );

  // клик по задизейбленному дню за границей не должен ничего выбирать
  if (afterMax.length > 0) {
    const before = await s.eval(`document.getElementById('date-toggle-label').textContent`);
    const disabledIso = afterMax[0].iso;
    await s.eval(`(function(){
      const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
      const target = btns.find((b) => b.dataset.iso === ${JSON.stringify(disabledIso)});
      if (target) target.click();
    })()`);
    await new Promise((r) => setTimeout(r, 80));
    const after = await s.eval(`document.getElementById('date-toggle-label').textContent`);
    check('клик по задизейбленному дню за границей не меняет выбранную дату', before === after);
  }

  // regression guard: вернуться в текущий месяц и убедиться, что нижняя граница (calPrev) не сломана
  for (let i = 0; i < clicks; i++) {
    await s.click('#cal-prev');
    await new Promise((r) => setTimeout(r, 60));
  }
  const prevDisabledBackAtStart = await s.eval(`document.getElementById('cal-prev').disabled`);
  check('после возврата в текущий месяц calPrev снова дизейблен (нижняя граница не сломана)', prevDisabledBackAtStart === true);
});

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
