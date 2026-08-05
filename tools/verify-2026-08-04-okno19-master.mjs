// Живая проверка Окна 19 на РЕАЛЬНОМ проде (GitHub Pages + Amvera, не мок) -
// Definition of done промпта требует именно это. QA-логин мастера -
// migrations/029_qa_window19_master.sql (уже задеплоен и подтверждён curl'ом).
// ALLOWED_ORIGIN ограничивает CORS до GitHub Pages (см. memory reference_amvera-
// deploy-gotchas.md) - навигация идёт на живой прод-URL, не localhost.
import { withBrowser } from './cdp.mjs';

const BASE = 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';

let failures = 0;
function checkTrue(label, actual) {
  console.log(`${actual ? '✔' : '✘'} ${label}`);
  if (!actual) failures++;
  return actual;
}

await withBrowser(async (s) => {
  await s.setViewport(1280, 1700, false);
  await s.navigate(`${BASE}/crm-master.html`);
  await s.sleep(1200);
  await s.eval(`(function(){
    document.getElementById('loginEmail').value = 'qa-window19-master@alikhan.test';
    document.getElementById('loginPin').value = '4471';
    document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await s.sleep(3500);

  const gateHidden = await s.eval(`document.getElementById('loginGate')?.hidden`);
  checkTrue('QA master-логин прошёл (loginGate скрыт)', gateHidden);

  // --- Задача 1: "Мой день" - реальная навигация по датам ---
  const dateBefore = await s.eval(`document.getElementById('dayNavDate')?.dataset.value`);
  await s.click('#dayNavNext');
  await s.sleep(900);
  const dateAfter = await s.eval(`document.getElementById('dayNavDate')?.dataset.value`);
  checkTrue(`Мой день: клик "вперёд" продвинул дату (${dateBefore} → ${dateAfter})`, !!dateBefore && dateBefore !== dateAfter);

  // --- Задача 1: "Неделя" - реальный грид, без переключателя мастеров ---
  await s.click('label[for="sp-week"]');
  await s.sleep(1200);
  const weekGridHtml = await s.eval(`document.getElementById('weekGrid')?.innerHTML.length`);
  const weekHasSwitch = await s.eval(`!!document.getElementById('weekMasterSwitch')?.innerHTML.trim()`);
  // Окно 25 (05.08.2026): подпись диапазона переехала из строки стрелок в общий
  // якорь под вкладками (#scheduleViewAnchor) - две одинаковые подписи на экране
  // были дублем. Проверяем ту же суть на новом месте, формат теперь словесный.
  const weekLabel = await s.eval(`document.getElementById('scheduleViewAnchor')?.textContent`);
  checkTrue(`Неделя: weekGrid реально заполнен (${weekGridHtml} байт HTML)`, weekGridHtml > 50);
  checkTrue('Неделя: переключателя мастеров нет (у мастера мастер всегда один)', !weekHasSwitch);
  checkTrue(`Неделя: подпись диапазона дат реальная ("${weekLabel}")`, /^Неделя · \d{1,2}/.test(weekLabel || ''));

  // --- Задача 1: "Месяц" - реальный грид, без карандаша редактирования ---
  await s.click('label[for="sp-month"]');
  await s.sleep(1200);
  const monthGridHtml = await s.eval(`document.getElementById('monthGrid')?.innerHTML.length`);
  const monthHasEditPencil = await s.eval(`!!document.querySelector('.month-day-edit')`);
  const monthHasSwitch = await s.eval(`!!document.getElementById('monthMasterSwitch')?.innerHTML.trim()`);
  const monthHasModal = await s.eval(`!!document.getElementById('dayEditModal')`);
  checkTrue(`Месяц: monthGrid реально заполнен (${monthGridHtml} байт HTML)`, monthGridHtml > 50);
  checkTrue('Месяц: иконки редактирования (✎) нет - мастер не редактирует график', !monthHasEditPencil);
  checkTrue('Месяц: переключателя мастеров нет', !monthHasSwitch);
  checkTrue('Месяц: модалки редактирования дня в DOM нет вообще', !monthHasModal);

  // --- Задача 2: "Личные данные" → "График работы" read-only ---
  await s.click('label[for="pt-c"]');
  await s.sleep(1500);
  const weeklyHtml = await s.eval(`document.getElementById('weeklyEditor-self')?.innerHTML.length`);
  const hasSendButton = await s.eval(`!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Отправить запрос на график'))`);
  const weeklyHasSelects = await s.eval(`document.querySelectorAll('#weeklyEditor-self select, #weeklyEditor-self input').length`);
  checkTrue(`График работы: реально загружен (${weeklyHtml} байт HTML)`, weeklyHtml > 50);
  checkTrue('График работы: кнопки "Отправить запрос на график" больше нет', !hasSendButton);
  checkTrue('График работы: read-only - нет select/input внутри строк дней', weeklyHasSelects === 0);

  // --- Задача 3: баг "Отпуск" - поля времени не показываются, dateTo показывается ---
  await s.eval(`document.getElementById('reqCategory').value = 'otpusk'; document.getElementById('reqCategory').dispatchEvent(new Event('change', {bubbles:true}))`);
  await s.sleep(300);
  const timeFieldsHiddenForOtpusk = await s.eval(`getComputedStyle(document.getElementById('reqTimeFields')).display === 'none'`);
  const dateToVisibleForOtpusk = await s.eval(`getComputedStyle(document.getElementById('reqDateToWrap')).display !== 'none'`);
  const fullDayWrapHiddenForOtpusk = await s.eval(`getComputedStyle(document.getElementById('reqFullDayWrap')).display === 'none'`);
  checkTrue('Отпуск: поля времени скрыты (не показываются никогда)', timeFieldsHiddenForOtpusk);
  checkTrue('Отпуск: диапазон дат "по" виден (не трогали)', dateToVisibleForOtpusk);
  checkTrue('Отпуск: чекбокс "На весь день" скрыт (не относится к отпуску)', fullDayWrapHiddenForOtpusk);

  // Реальная отправка через UI на новую тестовую дату - проверяем requestType в API напрямую после.
  await s.eval(`document.getElementById('reqComment').value = 'QA Окно19 UI-репро отпуска'`);
  await s.click('#reqSubmitBtn');
  await s.sleep(1500);
  const resultText = await s.eval(`document.getElementById('reqResult')?.textContent`);
  checkTrue(`Отпуск: отправка через форму прошла ("${resultText}")`, /отправлен/i.test(resultText || ''));

  console.log(failures === 0 ? '\n=== ВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ ===' : `\n=== ${failures} ПРОВАЛЕННЫХ ПРОВЕРОК ===`);
});

process.exit(failures === 0 ? 0 : 1);
