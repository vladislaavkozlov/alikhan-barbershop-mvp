// Диагностика 17.08.2026, третий заход. Гипотеза: Влад видит в боевом кабинете
// «Владелец» под именем и поле «Должность: Мастер» внутри карточки - то есть мёртвую
// разметку-макет из crm-owner.html (panel-b, строки 508+), которая висит на экране,
// ПОКА renderTeam (assets/crm-team.js) не заменит её живыми карточками из GET /staff.
// Первые два прогона ждали 4 секунды и видели уже подменённый DOM - здесь снимаем
// экран каждые 250мс сразу после входа, чтобы поймать окно, в котором виден макет.
import { withBrowser } from './cdp.mjs';

// Окно 72 (28.08.2026): боевые логины и пароли убраны из кода - репозиторий публичный,
// а до этой правки пароли всех пятерых сотрудников салона лежали здесь открытым
// текстом. Скрипт берёт доступы из окружения, например:
//   OWNER_LOGIN=aliovsad OWNER_PIN=<пароль> node tools/diag-2026-08-17-statika-do-zagruzki.mjs
const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задан доступ ${name}. Пример: ${name}=<значение> node tools/diag-2026-08-17-statika-do-zagruzki.mjs`);
    process.exit(1);
  }
  return value;
};


const BASE = 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const ACCOUNT = { page: 'crm-owner.html', email: env('MANAGER_LOGIN'), pin: env('MANAGER_PIN') };

async function waitFor(s, selector, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await s.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await s.sleep(250);
  }
  return false;
}

// Признаки макета: поле «Должность (свободный текст)», строка «Оказывает услуги»,
// телефон-заглушка. Признак живых данных: карточка team-editor-card из crm-team.js
const PROBE = `(() => {
  const panel = document.querySelector('.panel-b');
  const text = panel?.innerText ?? '';
  return {
    живыхКарточек: document.querySelectorAll('.panel-b .team-editor-card').length,
    макетныхКарточек: document.querySelectorAll('.panel-b .staff-card:not(.team-editor-card):not(.team-add-card)').length,
    должность: /Должность/.test(text),
    оказываетУслуги: /Оказывает услуги/.test(text),
    телефонЗаглушка: /900 000-00-01/.test(text),
    подписиПодИменами: [...document.querySelectorAll('.panel-b .summary-meta')].map((m) => [m.querySelector('.name')?.textContent.trim(), m.querySelector('.role')?.textContent.trim()].filter(Boolean).join(' / ')),
  };
})()`;

await withBrowser(async (s) => {
  await s.navigate(`${BASE}/${ACCOUNT.page}`);
  if (!await waitFor(s, '#loginEmail')) throw new Error('нет формы логина');
  await s.type('#loginEmail', ACCOUNT.email);
  await s.type('#loginPin', ACCOUNT.pin);
  await s.click('#loginBtn, button[type=submit], .login-submit');

  // Раздел «Команда» - вторая вкладка, её надо открыть, иначе panel-b скрыта
  for (let i = 0; i < 40; i++) {
    if (await s.eval(`!!document.querySelector('#pt-b')`)) break;
    await s.sleep(250);
  }
  await s.eval(`document.querySelector('#pt-b')?.click()`);

  for (let tick = 0; tick < 24; tick++) {
    const probe = await s.eval(PROBE);
    console.log(`${String(tick * 250).padStart(5)}мс  живых:${probe.живыхКарточек} макетных:${probe.макетныхКарточек} должность:${probe.должность ? 'ЕСТЬ' : '-'} оказываетУслуги:${probe.оказываетУслуги ? 'ЕСТЬ' : '-'} телефон-заглушка:${probe.телефонЗаглушка ? 'ЕСТЬ' : '-'}`);
    if (tick === 0 || probe.макетныхКарточек > 0) console.log(`        подписи: ${JSON.stringify(probe.подписиПодИменами)}`);
    if (tick === 2) await s.screenshot('/tmp/diag-komanda-rano.png');
    await s.sleep(250);
  }
  await s.screenshot('/tmp/diag-komanda-pozdno.png');
});
