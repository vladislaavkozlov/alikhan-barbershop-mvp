// Приёмка деплоя 17.08.2026 на БОЕВОМ GitHub Pages + боевом API. Проверяет ровно то,
// что просил Влад, глазами каждой роли - и заодно что ничего не отвалилось:
//   владелец      - нет «Управления скидками», команда рисуется живыми карточками
//   управляющий   - кнопка сохранения в карточке владельца просыпается от витрины
//   администратор - нет поля «Точка», есть смена PIN, кабинет грузится без денег
//   мастер        - две вкладки (нет «Моей зарплаты»), нет поля «Ставка от выручки»
// Ничего не сохраняет: только читает экран. Правку сохранения проверял отдельный
// прогон verify-2026-08-17-vitrina-vladelca-u-upravlyayushchego.mjs до деплоя.
import { withBrowser } from './cdp.mjs';

// Окно 72 (28.08.2026): боевые логины и пароли убраны из кода - репозиторий публичный,
// а до этой правки пароли всех пятерых сотрудников салона лежали здесь открытым
// текстом. Скрипт берёт доступы из окружения, например:
//   OWNER_LOGIN=aliovsad OWNER_PIN=<пароль> node tools/verify-2026-08-17-prod-posle-deploya.mjs
const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задан доступ ${name}. Пример: ${name}=<значение> node tools/verify-2026-08-17-prod-posle-deploya.mjs`);
    process.exit(1);
  }
  return value;
};


// Окно 72 (28.08.2026): боевые логин и пароль владельца убраны из кода - репозиторий
// публичный. Скрипт берёт их из окружения и без них не запускается:
//   OWNER_LOGIN=<логин> OWNER_PIN=<пароль> node tools/verify-2026-08-17-prod-posle-deploya.mjs


const BASE = 'https://vladislaavkozlov.github.io/alikhan-barbershop-mvp';
const ROLES = {
  владелец: { page: 'crm-owner.html', email: env('OWNER_LOGIN'), pin: OWNER_PIN },
  управляющий: { page: 'crm-owner.html', email: env('MANAGER_LOGIN'), pin: env('MANAGER_PIN') },
  администратор: { page: 'crm-admin.html', email: env('ADMIN_LOGIN'), pin: env('ADMIN_PIN') },
  мастер: { page: 'crm-master.html', email: env('MASTER_LOGIN'), pin: env('MASTER_PIN') },
};

let passed = 0;
let failed = 0;
function check(ok, title, detail = '') {
  if (ok) { passed++; console.log(`  OK   ${title}`); }
  else { failed++; console.log(`  FAIL ${title}${detail ? ` -> ${detail}` : ''}`); }
}

const TABS = `[...document.querySelectorAll('.tab-bar label')].map((l) => l.textContent.trim())`;
const TEXT = `document.body.innerText`;
const LIVE_CARDS = `[...document.querySelectorAll('.team-editor-card')].map((c) => [c.querySelector('.name')?.textContent.trim(), c.querySelector('.role')?.textContent.trim()].join(' / '))`;

// Ждать видимости, а не просто наличия в DOM: панели вкладок лежат в разметке всегда,
// показывает их CSS по :checked, и снимок innerText, сделанный слишком рано, не
// содержит текста ещё скрытой панели. Так 17.08.2026 покраснела рабочая смена PIN
async function waitVisible(s, selector, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await s.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.offsetParent !== null; })()`)) return true;
    await s.sleep(250);
  }
  return false;
}

async function waitFor(s, selector, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await s.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await s.sleep(250);
  }
  return false;
}

await withBrowser(async (s) => {
  for (const [role, account] of Object.entries(ROLES)) {
    console.log(`\n=== ${role.toUpperCase()} ===`);
    // Кэш GitHub Pages живёт ~10 минут - метка времени в адресе гарантирует свежие файлы
    await s.navigate(`${BASE}/${account.page}?v=${Date.now()}`);
    if (!await waitFor(s, '#loginEmail')) { check(false, `${role}: форма входа появилась`); continue; }
    await s.type('#loginEmail', account.email);
    await s.type('#loginPin', account.pin);
    await s.click('#loginBtn, button[type=submit], .login-submit');
    await s.sleep(4500);

    const tabs = await s.eval(TABS);
    const text = await s.eval(TEXT);
    console.log(`  вкладки: ${JSON.stringify(tabs)}`);

    check(!/Не удалось загрузить/i.test(text), `${role}: кабинет загрузился без ошибок`);

    if (role === 'владелец' || role === 'управляющий') {
      check(!text.includes('Управление скидками'), `${role}: блока «Управление скидками» нет`);
      await s.eval(`document.querySelector('#pt-b')?.click()`);
      // Ждём появления карточек, а не фиксированную паузу: команда приходит из сети, и
      // на холодном старте браузера 2.5 секунды не хватало - прогон краснел на рабочем
      // продукте (17.08.2026, проверено отдельным заходом: карточки на месте и до, и
      // после клика по вкладке, просто позже)
      await waitFor(s, '.team-editor-card', 60);
      const cards = await s.eval(LIVE_CARDS);
      check(cards.length > 0, `${role}: команда нарисована живыми карточками`, JSON.stringify(cards));
      check(!/Оказывает услуги|Должность|900 000-00-01/.test(await s.eval(TEXT)), `${role}: макетных надписей на экране нет`);
      const owner = cards.find((c) => c.startsWith('Алиовсад'));
      check(owner === 'Алиовсад / Владелец', `${role}: у Алиовсада одна должность - Владелец`, String(owner));
    }

    if (role === 'управляющий') {
      const card = `document.querySelector('.team-editor-card[data-staff-id="master-1"]')`;
      await s.eval(`${card}?.setAttribute('open','')`);
      await s.sleep(500);
      const before = await s.eval(`${card}.querySelector('[data-save]').disabled`);
      await s.eval(`(function(){const t=${card}.querySelector('[name=publicProfileEnabled]');t.checked=!t.checked;t.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      const after = await s.eval(`${card}.querySelector('[data-save]').disabled`);
      check(before === true && after === false, 'управляющий: галка витрины будит кнопку «Сохранить изменения»', `до=${before} после=${after}`);
      // Ничего не сохраняем - возвращаем галку на место
      await s.eval(`(function(){const t=${card}.querySelector('[name=publicProfileEnabled]');t.checked=!t.checked;t.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    }

    if (role === 'администратор') {
      check(!/Точка/.test(text), 'администратор: пункта «Точка» в личных данных нет');
      await s.eval(`document.querySelector('#pt-c')?.click()`);
      check(await waitVisible(s, '#pinSaveBtn'), 'администратор: появилась смена своего PIN');
      check(!/Выручка|Зарплат/i.test(text), 'администратор: денежных блоков нет');
    }

    if (role === 'мастер') {
      check(tabs.length === 2 && !tabs.includes('Моя зарплата'), 'мастер: вкладки «Моя зарплата» нет', JSON.stringify(tabs));
      await s.eval(`document.querySelector('#pt-c')?.click()`);
      const pinVisible = await waitVisible(s, '#pinSaveBtn');
      const selfText = await s.eval(TEXT);
      check(!/Ставка от выручки/.test(selfText), 'мастер: поля «Ставка от выручки, %» нет');
      check(pinVisible, 'мастер: смена своего PIN на месте');
    }

    await s.screenshot(`/tmp/prod-${role}.png`);
  }
});

console.log(`\nИТОГ: ${passed} прошло, ${failed} провалено`);
process.exit(failed ? 1 : 0);
