// Дизайн-аудит CRM (11.08.2026) - НЕ verify-скрипт: ничего не проверяет на pass/fail,
// его задача - снять полный набор живых экранов всех трёх кабинетов в двух вьюпортах,
// чтобы дизайнер смотрел на реальный продукт с реальными данными, а не на пустой UI.
//
// Почему эфемерный сервер, а не живой прод: боевые креды - только на чтение и только
// по явному разрешению Влада, а логин в прод-CRM записал бы сессию в боевую базу.
// Здесь всё одноразовое (своя БД, свой порт, свои QA-аккаунты, всё сносится в finally).
//
// Данные сеются НЕ пустыми намеренно: пустой интерфейс нельзя оценивать дизайнерски -
// не видно плотности, переполнения, поведения длинных имён, реальной сетки расписания.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const OUT = process.env.AUDIT_OUT || `${process.env.HOME}/Desktop/crm-design-audit-2026-08-11`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];

// Разделы ровно по ROLE_CONFIG в assets/crm-app-shell.js - не выдуманный список.
const SECTIONS = {
  owner:  ['schedule', 'team', 'finance', 'analytics', 'notifications'],
  admin:  ['schedule', 'team'],
  master: ['today', 'payroll', 'profile'],
};

async function shoot(s, name, viewport) {
  const path = `${OUT}/${name}--${viewport}.png`;
  await s.screenshot(path);
  shots.push(path);
  console.log(`  снят  ${name} (${viewport})`);
}

// Переключение раздела через тот же публичный роутер, которым пользуется сам shell.
// Имя именно crmGoToSection (assets/crm-app-shell.js:208) - goToSection это ES-экспорт
// модуля, в window его нет, обращение к нему давало ложный NO_ROUTER.
async function goSection(s, section) {
  const r = await s.eval(`(function(){
    if (typeof window.crmGoToSection !== 'function') return 'NO_ROUTER';
    window.crmGoToSection(${JSON.stringify(section)});
    return 'OK';
  })()`);
  await sleep(1400);
  return r;
}

async function loginAs(s, base, page, email, pin) {
  await s.navigate(`${base}/${page}`);
  await sleep(700);
  await s.type('#loginEmail', email);
  await s.type('#loginPin', pin);
  await s.click('#loginForm button[type="submit"]');
  await sleep(3200);
  // ВАЖНО: reveal() в crm-auth.js не удаляет #loginGate из DOM, а ставит hidden=true -
  // проверка "элемент существует" всегда true и даёт ложный провал. Меряем реальную
  // видимость через offsetParent (учитывает и hidden, и display:none у родителей).
  return s.eval(`(function(){
    const g = document.getElementById('loginGate');
    return !!g && g.offsetParent === null;
  })()`);
}

// Обход одной роли в одном вьюпорте: чистая сессия → логин → каждый раздел → снимок.
async function walkRole(s, base, { role, page, email, pin, viewport, w, h, mobile }) {
  await s.setViewport(w, h, mobile);
  // Сессия предыдущей роли живёт в localStorage. Раньше эту изоляцию давал отдельный
  // withBrowser на каждую роль, но cdp.mjs держит ФИКСИРОВАННЫЙ порт 9333, и шесть
  // последовательных Chrome дрались за него ("Could not ..." вместо JSON от /json/new).
  // Один браузер + явная чистка storage даёт ту же изоляцию без гонки за порт.
  await s.navigate(`${base}/${page}`);
  await s.eval(`(function(){ try { localStorage.clear(); sessionStorage.clear(); } catch(e){} return 'OK'; })()`);

  const logged = await loginAs(s, base, page, email, pin);
  if (!logged) throw new Error(`${role}: вход не прошёл (гейт остался видимым)`);
  await shoot(s, `${role}-01-вход-по-умолчанию`, viewport);

  let i = 2;
  for (const section of SECTIONS[role]) {
    const res = await goSection(s, section);
    if (res !== 'OK') { console.log(`  ПРОПУСК ${role}/${section}: ${res}`); continue; }
    await shoot(s, `${role}-${String(i).padStart(2, '0')}-${section}`, viewport);
    i++;
  }
}
const { mkdirSync } = await import('node:fs');
mkdirSync(OUT, { recursive: true });

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pins = { owner: randomPin(), admin: randomPin(), master: randomPin() };

    // Три роли + второй мастер (без доступа в систему) - чтобы разделы "Команда"/
    // "Сотрудники" и сетка расписания были не однострочными.
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('da-owner',  1, 'Алиовсад Алиханов',   'owner',  true, true, true,  'da-owner@test.local',  $1),
       ('da-admin',  1, 'Мамедхан Алиханов',   'admin',  true, false, true, 'da-admin@test.local',  $2),
       ('da-master', 1, 'Екатерина Северцова', 'master', true, true, true,  'da-master@test.local', $3),
       ('da-m2',     1, 'Рустам Гаджиев',      'master', true, true, false, NULL, NULL)`,
      [hashPin(pins.owner), hashPin(pins.admin), hashPin(pins.master)]
    );

    const workers = ['da-owner', 'da-master', 'da-m2'];
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m, wd, true, '10:00', '20:00'
       FROM generate_series(1,7) AS wd, (VALUES ('da-owner'),('da-master'),('da-m2')) AS t(m)`
    );

    // Прайс мастеров - реальные id услуг из миграции 002_schema.sql, цены из неё же.
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('da-owner',  'strizhka', 2000, 40), ('da-owner',  'boroda', 1600, 30),
       ('da-owner',  'kompleks-strizhka-boroda', 3500, 60),
       ('da-master', 'strizhka', 1800, 40), ('da-master', 'spa-uhod', 3000, 60),
       ('da-m2',     'strizhka', 1800, 40), ('da-m2', 'britie', 1500, 40)`
    );

    const login = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'da-owner@test.local', pin: pins.owner }),
    });
    const { token } = await login.json();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Живой день: записи разной длины, у разных мастеров, с окнами между ними -
    // включая длинное имя и запись без телефона (walk-in), чтобы поймать переполнение.
    const today = daysFromToday(0);
    const day = [
      ['da-owner',  ['strizhka'], '10:00', 'Тимур Абдулкеримов', '+79991112233'],
      ['da-owner',  ['kompleks-strizhka-boroda'], '12:00', 'Артём Ковалевский-Заречный', '+79992223344'],
      ['da-owner',  ['boroda'], '15:00', 'Иван Петров', '+79993334455'],
      ['da-master', ['strizhka'], '11:00', 'Сергей Ким', '+79994445566'],
      ['da-master', ['spa-uhod'], '14:00', 'Мурад Гасанов', '+79995556677'],
      ['da-m2',     ['strizhka'], '10:30', 'Пётр Сидоров', '+79996667788'],
      ['da-m2',     ['britie'], '16:00', 'Николай Ершов', '+79997778899'],
    ];
    for (const [masterId, serviceIds, startTime, clientName, clientPhone] of day) {
      const r = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ masterId, serviceIds, date: today, startTime, clientName, clientPhone, channel: 'admin' }),
      });
      if (r.status !== 200) console.log(`  фикстура ${startTime} ${masterId} → ${r.status}: ${await r.text()}`);
    }
    // Пара визитов в прошлом - чтобы "Финансы"/"Моя зарплата" показали ненулевые числа.
    for (const [d, t] of [[daysFromToday(-1), '11:00'], [daysFromToday(-2), '13:00']]) {
      const r = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ masterId: 'da-master', serviceIds: ['strizhka'], date: d, startTime: t, clientName: 'Рустам Постоянный', clientPhone: '+79990001122', channel: 'admin' }),
      });
      if (r.status === 200) {
        const id = (await r.json()).booking?.id;
        if (id) await fetch(`${apiUrl}/bookings/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'done' }) });
      }
    }

    const ROLES = [
      { role: 'owner',  page: 'crm-owner.html',  email: 'da-owner@test.local',  pin: pins.owner },
      { role: 'admin',  page: 'crm-admin.html',  email: 'da-admin@test.local',  pin: pins.admin },
      { role: 'master', page: 'crm-master.html', email: 'da-master@test.local', pin: pins.master },
    ];
    const VIEWPORTS = [
      { viewport: 'desktop-1440', w: 1440, h: 1000, mobile: false },
      { viewport: 'mobile-390',   w: 390,  h: 844,  mobile: true  },
    ];

    await withStaticServer(apiUrl, async (base) => {
      // Один браузер на весь прогон - изоляция ролей через localStorage.clear() в
      // walkRole (см. комментарий там про фиксированный порт 9333 в cdp.mjs).
      await withBrowser(async (s) => {
        for (const vp of VIEWPORTS) {
          for (const r of ROLES) {
            console.log(`\n=== ${r.role} · ${vp.viewport} ===`);
            await walkRole(s, base, { ...r, ...vp });
          }
        }
      });
    });
  });

  console.log(`\nГОТОВО. Снято ${shots.length} экранов в ${OUT}`);
} catch (e) {
  console.error(`\nАУДИТ УПАЛ: ${e.message}`);
  console.error(`Успел снять ${shots.length} экранов в ${OUT}`);
  process.exitCode = 1;
}

