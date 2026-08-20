// Второй проход дизайн-аудита (11.08.2026): первый снял все разделы СВЁРНУТЫМИ
// (все блоки - <details>, закрыты по умолчанию), поэтому по нему нельзя судить о
// реальной плотности данных и вёрстке содержимого. Здесь раскрываем все details
// в разделе и снимаем полную высоту страницы (captureBeyondViewport), чтобы увидеть
// то, что видит владелец после кликов.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const OUT = `${process.env.HOME}/Desktop/crm-design-audit-2026-08-11/раскрытые`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];

const SECTIONS = {
  owner:  ['schedule', 'team', 'finance', 'analytics', 'notifications'],
  admin:  ['schedule', 'team'],
  master: ['today', 'payroll', 'profile'],
};

// Полностраничный скриншот: обычный captureScreenshot режет по вьюпорту, а нам нужна
// вся длина раскрытого раздела.
async function fullShot(s, name) {
  const m = await s.send('Page.getLayoutMetrics');
  const h = Math.min(Math.ceil(m.contentSize.height), 12000);
  const w = Math.ceil(m.contentSize.width);
  const res = await s.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
  });
  const fs = await import('node:fs');
  const path = `${OUT}/${name}.png`;
  fs.writeFileSync(path, Buffer.from(res.data, 'base64'));
  shots.push(path);
  console.log(`  снят  ${name} (${w}x${h})`);
}

// Раскрываем ВСЕ details в видимой части, включая вложенные, и ждём дозагрузку.
async function expandAll(s) {
  const n = await s.eval(`(function(){
    let n = 0;
    document.querySelectorAll('details').forEach(d => { if (!d.open) { d.open = true; n++; }
      d.dispatchEvent(new Event('toggle')); });
    return n;
  })()`);
  await sleep(900);
  // Второй проход - вложенные details, которые появились после раскрытия внешних.
  await s.eval(`(function(){
    document.querySelectorAll('details').forEach(d => { if (!d.open) { d.open = true;
      d.dispatchEvent(new Event('toggle')); } });
    return true;
  })()`);
  await sleep(1200);
  return n;
}

async function loginAs(s, base, page, email, pin) {
  await s.navigate(`${base}/${page}`);
  await s.eval(`(function(){ try { localStorage.clear(); sessionStorage.clear(); } catch(e){} return 'OK'; })()`);
  await s.navigate(`${base}/${page}`);
  await sleep(700);
  await s.type('#loginEmail', email);
  await s.type('#loginPin', pin);
  await s.click('#loginForm button[type="submit"]');
  await sleep(3200);
  return s.eval(`(function(){ const g = document.getElementById('loginGate'); return !!g && g.offsetParent === null; })()`);
}
const { mkdirSync } = await import('node:fs');
mkdirSync(OUT, { recursive: true });

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pins = { owner: randomPin(), admin: randomPin(), master: randomPin() };

    // Те же фикстуры, что в первом проходе. ВАЖНАЯ ПОПРАВКА к первому прогону:
    // миграция 002_schema.sql уже сеет 3 placeholder-мастеров (Алиовсад/Мамедхан/
    // Елизавета) - именно они попали в "Команду" и в алерты "нет графика", а не мои
    // QA-аккаунты. Здесь даю placeholder-мастерам график, чтобы алерты не забивали
    // экран и было видно нормальное состояние раздела, а не аварийное.
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
       ('da-owner',  1, 'Алиовсад Алиханов',   'owner',  true, true,  true, 'da-owner@test.local',  $1),
       ('da-admin',  1, 'Мамедхан Алиханов',   'admin',  true, false, true, 'da-admin@test.local',  $2),
       ('da-master', 1, 'Екатерина Северцова', 'master', true, true,  true, 'da-master@test.local', $3)`,
      [hashPin(pins.owner), hashPin(pins.admin), hashPin(pins.master)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT m, wd, true, '10:00', '20:00'
       FROM generate_series(1,7) AS wd,
            (VALUES ('da-owner'),('da-master'),('master-1'),('master-2'),('master-3')) AS t(m)
       ON CONFLICT DO NOTHING`
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES
       ('da-owner',  'strizhka', 2000, 40), ('da-owner', 'boroda', 1600, 30),
       ('da-owner',  'kompleks-strizhka-boroda', 3500, 60),
       ('da-master', 'strizhka', 1800, 40), ('da-master', 'spa-uhod', 3000, 60)
       ON CONFLICT DO NOTHING`
    );

    const login = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'da-owner@test.local', pin: pins.owner }),
    });
    const { token } = await login.json();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const today = daysFromToday(0);

    const day = [
      ['da-owner',  ['strizhka'], '10:00', 'Тимур Абдулкеримов', '+79991112233'],
      ['da-owner',  ['kompleks-strizhka-boroda'], '12:00', 'Артём Ковалевский-Заречный', '+79992223344'],
      ['da-owner',  ['boroda'], '15:00', 'Иван Петров', '+79993334455'],
      ['da-master', ['strizhka'], '11:00', 'Сергей Ким', '+79994445566'],
      ['da-master', ['spa-uhod'], '14:00', 'Мурад Гасанов', '+79995556677'],
    ];
    for (const [masterId, serviceIds, startTime, clientName, clientPhone] of day) {
      const r = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ masterId, serviceIds, date: today, startTime, clientName, clientPhone, channel: 'admin' }),
      });
      if (r.status !== 200) console.log(`  фикстура ${startTime} → ${r.status}: ${(await r.text()).slice(0, 120)}`);
    }
    // Закрытые визиты в прошлом - чтобы Финансы/Зарплата показали ненулевые суммы.
    for (const [d, t] of [[daysFromToday(-1), '11:00'], [daysFromToday(-2), '13:00'], [daysFromToday(-3), '16:00']]) {
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

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        for (const { role, page, email, pin } of ROLES) {
          console.log(`\n=== ${role} · раскрытые разделы ===`);
          await s.setViewport(1440, 1000, false);
          const ok = await loginAs(s, base, page, email, pin);
          if (!ok) { console.log(`  ПРОПУСК ${role}: вход не прошёл`); continue; }

          for (const section of SECTIONS[role]) {
            const r = await s.eval(`(function(){
              if (typeof window.crmGoToSection !== 'function') return 'NO_ROUTER';
              window.crmGoToSection(${JSON.stringify(section)});
              return 'OK';
            })()`);
            if (r !== 'OK') { console.log(`  ПРОПУСК ${role}/${section}: ${r}`); continue; }
            await sleep(1400);
            const opened = await expandAll(s);
            await fullShot(s, `${role}-${section}-раскрыто`);
            console.log(`     (раскрыто блоков: ${opened})`);
          }
        }
      });
    });
  });
  console.log(`\nГОТОВО. Снято ${shots.length} экранов в ${OUT}`);
} catch (e) {
  console.error(`\nУПАЛ: ${e.message}`);
  console.error(`Успел снять ${shots.length} в ${OUT}`);
  process.exitCode = 1;
}

