// Живая проверка Окна 53, задача G - короткие записи не наезжают на соседние.
// Причина (подтверждена промптом и расчётом): PX_PER_MIN=64/60, CSS .appt{min-height:34px}
// побеждала инлайновый height на любой брони короче ~32 мин. Реальный минимум длительности
// в прайсе Алихана - "Воск" 15 мин (api/migrations/002_schema.sql) - карточка рисовалась
// физически длиннее своего 15-минутного слота и перекрывала следующую запись в колонке.
// Фикс: CSS min-height снижен до 16px (реальный расчёт 15×64/60), плюс JS помечает
// короткие карточки (.appt--compact) - .c (клиент·услуга) скрывается, чтобы не влезать
// криво в урезанную высоту; полный текст (клиент/услуга) остаётся доступен кликом -
// openBooking() читает data-client/data-service, не видимый .c. Hover-раскрытие высоты
// пробовали и убрали - оно возвращало ровно тот же дефект наложения текста, просто по
// требованию hover.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedAndLogin(db, apiUrl) {
  const pinOwner = randomPin();
  const today = daysFromToday(0);
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('o53g-owner', NULL, 'QA Владелец G', 'owner', true, false, true, 'o53g-owner@test.local', $1),
     ('o53g-master1', NULL, 'QA Мастер G', 'master', true, true, true, 'o53g-master1@test.local', $2)`,
    [hashPin(pinOwner), hashPin(randomPin())]
  );
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT 'o53g-master1', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd`
  );
  // Реальные длительности из прайса Алихана (services, migration 002) - не выдуманные числа.
  await db.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min)
     SELECT 'o53g-master1', id, price, duration_min FROM services WHERE id IN ('vosk', 'strizhka')`
  );
  // "Воск" 15 мин 11:00-11:15 вплотную к следующей записи 11:15-11:55 (Стрижка, 40 мин) -
  // ровно сценарий промпта ("короткая услуга вплотную к соседней").
  await db.query(
    `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
     ('o53g-b1', 1, 'o53g-master1', 'vosk', NULL, $1, '11:00', '11:15', 'planned', 'admin'),
     ('o53g-b2', 1, 'o53g-master1', 'strizhka', NULL, $1, '11:15', '11:55', 'planned', 'admin')`,
    [today]
  );
  await db.query(`INSERT INTO clients (id, name, phone) VALUES ('o53g-c1','Короткий Клиент','+79990053001'), ('o53g-c2','Соседний Клиент','+79990053002')`);
  await db.query(`UPDATE bookings SET client_id = 'o53g-c1' WHERE id = 'o53g-b1'`);
  await db.query(`UPDATE bookings SET client_id = 'o53g-c2' WHERE id = 'o53g-b2'`);

  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'o53g-owner@test.local', pin: pinOwner }),
  });
  if (res.status !== 200) throw new Error(`login → ${res.status}`);
  return pinOwner;
}

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const pinOwner = await seedAndLogin(db, apiUrl);

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (s) => {
        await s.navigate(`${base}/crm-owner.html`);
        await s.setViewport(1440, 1100, true);
        await sleep(400);
        await s.type('#loginEmail', 'o53g-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);
        await s.click('#scheduleCard-day summary');
        await sleep(600);
        await s.screenshot('/tmp/okno53-taskG-after-fix.png');

        const geom = await s.eval(`(() => {
          const short = document.querySelector('.appt[data-id="o53g-b1"]');
          const next = document.querySelector('.appt[data-id="o53g-b2"]');
          if (!short || !next) return null;
          const rShort = short.getBoundingClientRect();
          const rNext = next.getBoundingClientRect();
          return {
            shortHeight: Math.round(rShort.height),
            shortBottom: Math.round(rShort.bottom),
            nextTop: Math.round(rNext.top),
            shortHasCompact: short.classList.contains('appt--compact'),
            cVisible: getComputedStyle(short.querySelector('.c')).display !== 'none',
          };
        })()`);
        check('Обе карточки (короткая 15-мин "Воск" и соседняя) найдены в DOM', geom !== null, JSON.stringify(geom));
        check(
          'Задача G: короткая карточка НЕ заходит на территорию следующей записи (низ короткой ≤ верх следующей)',
          geom && geom.shortBottom <= geom.nextTop,
          JSON.stringify(geom)
        );
        check('Задача G: короткая (15 мин < 32 мин) карточка помечена .appt--compact', geom?.shortHasCompact === true, JSON.stringify(geom));
        check('Задача G: строка "клиент · услуга" скрыта в компактном режиме (не обрезается криво)', geom?.cVisible === false, JSON.stringify(geom));

        // Полная информация о короткой брони по-прежнему доступна кликом (openBooking
        // читает data-client/data-service с элемента, не видимый текст .c).
        const dataAttrsIntact = await s.eval(`(() => {
          const el = document.querySelector('.appt[data-id="o53g-b1"]');
          return { client: el.dataset.client, service: el.dataset.service };
        })()`);
        check('Задача G: клиент/услуга короткой брони доступны по клику (data-атрибуты не урезаны)', dataAttrsIntact.client === 'Короткий Клиент' && /Воск/.test(dataAttrsIntact.service || ''), JSON.stringify(dataAttrsIntact));

        // ── Регрессия: обычная (40-мин) запись НЕ компактная, .c видна как обычно ──
        const normalState = await s.eval(`(() => {
          const el = document.querySelector('.appt[data-id="o53g-b2"]');
          return { isCompact: el.classList.contains('appt--compact'), cVisible: getComputedStyle(el.querySelector('.c')).display !== 'none' };
        })()`);
        check('Регрессия: обычная 40-мин запись НЕ получает .appt--compact', normalState.isCompact === false, JSON.stringify(normalState));
        check('Регрессия: обычная запись показывает "клиент · услуга" как раньше (без hover)', normalState.cVisible === true, JSON.stringify(normalState));
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
