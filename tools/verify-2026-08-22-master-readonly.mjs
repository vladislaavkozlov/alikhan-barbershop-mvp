// Кабинет мастера - только просмотр (22.08.2026, правка Влада: «в кабинете мастеров
// удали пункт меню „Моя зарплата“; в личных данных удали надпись „Портфолио
// редактируете сами, остальное назначает владелец“; и сделай так, чтобы они могли
// только смотреть свои данные, но не могли их менять, всё корректируется через
// владельца или управляющего»).
//
// Прогон отвечает на два разных вопроса, и второй важнее первого:
//   1) что видит мастер на экране (нет пункта меню, нет полей ввода и кнопок);
//   2) что ему разрешает СЕРВЕР, если постучаться в API мимо интерфейса - потому что
//      «только смотрит» в вёрстке не значит «только смотрит» на самом деле.
// Вторая часть бьёт настоящим токеном мастера по всем роутам, которыми его данные
// меняются: портфолио, карточка сотрудника, фото, услуги, недельный график, разовые
// смены. Ожидание - ни одного успеха.
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const masterPin = randomPin();
    const bossPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash,
                          experience_text, strengths_text, certificates_text)
       VALUES ('ro-master', 1, 'QA Мастер Просмотр', 'master', true, true, true, 'ro-master@alikhan.test', $1,
               '7 лет барбером', 'фейды, борода', 'Курс Wahl 2025')`,
      [hashPin(masterPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('ro-boss', 1, 'QA Владелец', 'owner', true, false, true, 'ro-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );

    // Без рабочего графика мастер не проходит фильтр видимости в GET /staff
    // (filterStaffForViewer, api/lib/schedule-core.js) и не видит даже собственную
    // карточку - на пустом экране «только просмотр» доказывался бы сам собой
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      await db.query(
        `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
         VALUES ('ro-master', $1, true, '10:00', '20:00')`,
        [weekday]
      );
    }

    async function login(email, pin) {
      const res = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pin }),
      });
      const data = await res.json();
      return data.token;
    }
    const masterToken = await login('ro-master@alikhan.test', masterPin);
    const bossToken = await login('ro-boss@alikhan.test', bossPin);
    check('мастер вообще может войти в кабинет (иначе проверки ниже ничего не значат)', !!masterToken);

    async function call(token, method, path, body) {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return res.status;
    }

    // ── 1. Сервер: мастер не может изменить НИ ОДНО своё поле ────────────────
    const writes = [
      ['портфолио (стаж, сильные стороны, сертификаты)', 'PUT', '/staff/ro-master/portfolio', { experienceText: 'взломано' }],
      ['карточка сотрудника (имя, телефон, витрина)', 'PUT', '/staff/ro-master', { name: 'Взломанное имя' }],
      ['порядок фотографий', 'PUT', '/staff/ro-master/media/order', { ids: [] }],
      ['роль', 'PUT', '/staff/ro-master/role', { role: 'owner' }],
      ['PIN для входа', 'PUT', '/staff/ro-master/pin', { pin: '9999' }],
      ['свои услуги и цены', 'PUT', '/master-services/ro-master/svc-1', { enabled: true }],
      ['недельный график', 'PUT', '/master-weekly-schedule', { masterId: 'ro-master', weeklyChanges: [] }],
      ['разовая смена в графике', 'POST', '/schedule', { masterId: 'ro-master', date: daysFromToday(1), startTime: '10:00', endTime: '20:00' }],
      ['удаление смены из графика', 'DELETE', '/schedule', { masterId: 'ro-master', date: daysFromToday(1) }],
    ];
    for (const [label, method, path, body] of writes) {
      const status = await call(masterToken, method, path, body);
      check(`сервер не даёт мастеру менять: ${label}`, status === 401 || status === 403 || status === 404, `HTTP ${status}`);
    }

    // Контроль: те же данные он ЧИТАЕТ - иначе «запрещено всё» достигалось бы просто
    // сломанным кабинетом, а не правами. Смотрим на СОДЕРЖИМОЕ ответа, а не на код:
    // первый заход этого прогона получал честные 200 с пустым массивом внутри
    async function read(path) {
      const res = await fetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${masterToken}` } });
      return { status: res.status, body: await res.json() };
    }
    const ownCard = await read('/staff');
    check('мастер по-прежнему видит свою карточку - и в ответе она действительно есть',
      ownCard.status === 200 && ownCard.body.some((r) => r.id === 'ro-master'), JSON.stringify(ownCard).slice(0, 200));
    const ownWeek = await read('/master-weekly-schedule');
    check('мастер по-прежнему видит свой недельный график',
      ownWeek.status === 200 && ownWeek.body.length === 7, `${ownWeek.status}, дней: ${ownWeek.body.length}`);
    const ownServices = await read('/master-services');
    check('мастер по-прежнему видит список услуг', ownServices.status === 200 && Array.isArray(ownServices.body), String(ownServices.status));

    // Контроль наоборот: владельцу править МОЖНО - правка не заперла данные вообще
    // Полный набор полей, как шлёт форма владельца: PUT перезаписывает карточку
    // целиком, и отправка одного поля обнулила бы остальные (первый заход прогона
    // именно так и стёр «сильные стороны»)
    const bossPortfolio = await call(bossToken, 'PUT', '/staff/ro-master/portfolio', {
      experienceText: '8 лет барбером',
      strengthsText: 'фейды, борода',
      certificatesText: 'Курс Wahl 2025',
      beforeAfterUrls: null,
    });
    check('владелец правит портфолио мастера как и раньше', bossPortfolio === 200, `HTTP ${bossPortfolio}`);

    // ── 2. Экран мастера ────────────────────────────────────────────────────
    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 1000);
        await s.navigate(`${siteUrl}/crm-master.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'ro-master@alikhan.test';
          document.getElementById('loginPin').value = '${masterPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        const menu = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('.app-nav-item')].map(b => b.textContent.trim()))`));
        check('в меню мастера нет пункта «Моя зарплата»', !menu.some((m) => /зарплат/i.test(m)), JSON.stringify(menu));
        check('остались «Мой день» и «Личные данные»',
          menu.length === 2 && /Мой день/.test(menu[0]) && /Личные данные/.test(menu[1]), JSON.stringify(menu));

        await s.eval(`document.querySelector('.app-nav-item[data-section="profile"]')?.click()`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#selfPortfolioView .self-fact'))`)); i++) await sleep(200);

        const profile = JSON.parse(await s.eval(`JSON.stringify({
          text: document.querySelector('.tab-panel.panel-c')?.textContent,
          inputs: [...document.querySelectorAll('.tab-panel.panel-c input, .tab-panel.panel-c textarea, .tab-panel.panel-c select')]
            .filter(n => !n.disabled && n.type !== 'hidden').map(n => n.id || n.type),
          buttons: [...document.querySelectorAll('.tab-panel.panel-c button')].map(b => b.textContent.trim()),
          facts: [...document.querySelectorAll('#selfPortfolioView .self-fact')].map(f => f.textContent.replace(/\\s+/g,' ').trim()),
        })`));

        check('надписи «Портфолио редактируете сами, остальное назначает владелец» больше нет',
          !/редактируете сами/.test(norm(profile.text)), norm(profile.text).slice(0, 160));
        check('в «Личных данных» не осталось ни одного живого поля ввода',
          profile.inputs.length === 0, JSON.stringify(profile.inputs));
        check('кнопки «Сохранить портфолио» нет',
          !profile.buttons.some((b) => /Сохранить/i.test(b)), JSON.stringify(profile.buttons));
        // Читать свои данные мастер должен - иначе это не «только просмотр», а пустой экран
        check('портфолио показано текстом: стаж и сильные стороны видны',
          /8 лет барбером/.test(norm(profile.text)) && /фейды, борода/.test(norm(profile.text)),
          JSON.stringify(profile.facts));
        check('незаполненное поле не исчезает, а честно помечено',
          /Фото «до-после» Не заполнено/.test(norm(profile.text)), JSON.stringify(profile.facts));
        check('сказано, кто эти данные меняет', /Заполняет владелец/.test(norm(profile.text)));
        check('услуги и график остались на экране (просмотр никуда не делся)',
          /Услуги/.test(norm(profile.text)) && /График работы/.test(norm(profile.text)));

        await s.screenshot('/tmp/master-profile-desktop.png');

        await s.setViewport(360, 900, true);
        await sleep(400);
        const mobile = JSON.parse(await s.eval(`JSON.stringify({
          docScroll: document.documentElement.scrollWidth,
          viewport: Math.round(window.visualViewport?.width || window.innerWidth),
        })`));
        check('360px: страница не переполнена по горизонтали', mobile.docScroll <= mobile.viewport + 1, JSON.stringify(mobile));
        await s.screenshot('/tmp/master-profile-mobile.png');
      });
    });
  });
} catch (e) {
  crashed = true;
  console.log('CRASH', e?.stack || e);
}

const ok = summary() && !crashed;
process.exit(ok ? 0 : 1);
