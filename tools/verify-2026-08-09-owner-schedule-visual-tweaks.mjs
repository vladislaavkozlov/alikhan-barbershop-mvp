// Живая проверка правки по скриншоту Влада 09.08.2026 (кабинет владельца, "День"):
// 1) короткая запись "Воск" (15 мин) - текст времени больше не прижат к нижней границе
//    карточки (padding/line-height внутри неизменных 16px, см. mockup-crm.css).
// 2) пунктирный превью-слот на пустом месте визуально выше (28px вместо 16px),
//    без изменения логики снаппинга и без риска наложения на реальные записи.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedAndLogin(db, apiUrl) {
  const pinOwner = randomPin();
  const today = daysFromToday(0);
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('vt-owner', NULL, 'QA Владелец VT', 'owner', true, false, true, 'vt-owner@test.local', $1),
     ('vt-master1', NULL, 'QA Мастер VT', 'master', true, true, true, 'vt-master1@test.local', $2)`,
    [hashPin(pinOwner), hashPin(randomPin())]
  );
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT 'vt-master1', wd, true, '10:00', '18:00' FROM generate_series(1, 7) AS wd`
  );
  await db.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min)
     SELECT 'vt-master1', id, price, duration_min FROM services WHERE id IN ('vosk', 'strizhka')`
  );
  // Тот же рисунок, что на скриншоте: 10:45-11:45 (стрижка), 11:45-12:00 (Воск, короткая,
  // вплотную с обеих сторон), 12:00-13:00 (стрижка) - потом свободно до 13:45.
  await db.query(
    `INSERT INTO bookings (id, location_id, master_id, service_id, client_id, date, start_time, end_time, status, channel) VALUES
     ('vt-b1', 1, 'vt-master1', 'strizhka', NULL, $1, '10:45', '11:45', 'planned', 'admin'),
     ('vt-b2', 1, 'vt-master1', 'vosk', NULL, $1, '11:45', '12:00', 'planned', 'admin'),
     ('vt-b3', 1, 'vt-master1', 'strizhka', NULL, $1, '12:00', '13:00', 'planned', 'admin')`,
    [today]
  );
  await db.query(`INSERT INTO clients (id, name, phone) VALUES ('vt-c1','Клиент А','+79990054001'), ('vt-c2','Клиент Б','+79990054002'), ('vt-c3','Клиент В','+79990054003')`);
  await db.query(`UPDATE bookings SET client_id = 'vt-c1' WHERE id = 'vt-b1'`);
  await db.query(`UPDATE bookings SET client_id = 'vt-c2' WHERE id = 'vt-b2'`);
  await db.query(`UPDATE bookings SET client_id = 'vt-c3' WHERE id = 'vt-b3'`);

  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vt-owner@test.local', pin: pinOwner }),
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
        await s.type('#loginEmail', 'vt-owner@test.local');
        await s.type('#loginPin', pinOwner);
        await s.click('#loginForm button[type="submit"]');
        await sleep(1300);
        await s.click('#scheduleCard-day summary');
        await sleep(600);

        // ── Часть 1: короткая карточка "Воск" (vt-b2) ──
        const shortGeom = await s.eval(`(() => {
          const short = document.querySelector('.appt[data-id="vt-b2"]');
          const prev = document.querySelector('.appt[data-id="vt-b1"]');
          const next = document.querySelector('.appt[data-id="vt-b3"]');
          const t = short.querySelector('.t');
          const rShort = short.getBoundingClientRect();
          const rT = t.getBoundingClientRect();
          const rPrev = prev.getBoundingClientRect();
          const rNext = next.getBoundingClientRect();
          return {
            shortHeight: Math.round(rShort.height),
            shortTop: Math.round(rShort.top),
            shortBottom: Math.round(rShort.bottom),
            prevBottom: Math.round(rPrev.bottom),
            nextTop: Math.round(rNext.top),
            gapAboveText: Math.round(rT.top - rShort.top),
            gapBelowText: Math.round(rShort.bottom - rT.bottom),
            textHeight: Math.round(rT.height),
          };
        })()`);
        check('Высота короткой карточки не изменилась (16px, инвариант Задачи G)', shortGeom.shortHeight === 16, JSON.stringify(shortGeom));
        check('Короткая карточка по-прежнему не наезжает на предыдущую запись (top >= низ предыдущей)', shortGeom.shortTop >= shortGeom.prevBottom, JSON.stringify(shortGeom));
        check('Короткая карточка по-прежнему не наезжает на следующую запись (bottom <= верх следующей)', shortGeom.shortBottom <= shortGeom.nextTop, JSON.stringify(shortGeom));
        check('Текст времени больше не прижат к нижней границе - есть отступ снизу (>0px)', shortGeom.gapBelowText > 0, JSON.stringify(shortGeom));
        check('Отступы сверху и снизу текста примерно равны (центрирование, не обрезание только снизу)', Math.abs(shortGeom.gapAboveText - shortGeom.gapBelowText) <= 1, JSON.stringify(shortGeom));

        await s.screenshot('/tmp/owner-schedule-visual-tweaks-after.png');

        // ── Часть 2: пунктирный превью-слот в свободном промежутке 13:00-13:45 ──
        // Эфемерная тестовая БД поднимает не только своих QA-мастеров - трек нужного
        // мастера находим ЧЕРЕЗ его реальную бронь (data-id="vt-b2"), а не первым
        // попавшимся '.schedule-track' в DOM (в дне владельца могут быть и другие
        // колонки без графика - раньше сюда случайно попадала пустая колонка).
        // Оборачиваем window.openSlotBooking ДО первого mousemove - обработчик в
        // crm-calendar.js гейтит показ превью наличием этой функции (typeof === 'function').
        await s.eval(`(() => { window.__openSlotBookingCalls = []; const real = window.openSlotBooking; window.openSlotBooking = (...args) => { window.__openSlotBookingCalls.push(args); return real?.(...args); }; })()`);
        const trackRect = await s.eval(`(() => {
          const track = document.querySelector('.appt[data-id="vt-b2"]').closest('.schedule-track');
          const r = track.getBoundingClientRect();
          return { left: r.left, top: r.top };
        })()`);
        // 13:15 (10:00 старт шкалы, 64px/час) - середина свободного окна 13:00-13:45.
        const targetY = Math.round(trackRect.top + (13 * 60 + 15 - 600) * (64 / 60)) + 5;
        const targetX = Math.round(trackRect.left + 40);
        await s.eval(`(() => {
          const track = document.querySelector('.appt[data-id="vt-b2"]').closest('.schedule-track');
          const evt = new MouseEvent('mousemove', { clientX: ${targetX}, clientY: ${targetY}, bubbles: true });
          track.dispatchEvent(evt);
        })()`);
        await sleep(200);
        const previewGeom = await s.eval(`(() => {
          const track = document.querySelector('.appt[data-id="vt-b2"]').closest('.schedule-track');
          const preview = track.querySelector('.appt--slot-preview');
          if (!preview || preview.hidden) return null;
          const r = preview.getBoundingClientRect();
          return { height: Math.round(r.height), hidden: preview.hidden };
        })()`);
        check('Превью-слот появился на свободном месте по mousemove', previewGeom !== null, JSON.stringify(previewGeom));
        check('Превью-слот стал визуально выше (28px вместо прежних 16px)', previewGeom?.height === 28, JSON.stringify(previewGeom));

        await s.screenshot('/tmp/owner-schedule-visual-tweaks-preview-after.png');

        // ── Регрессия: клик по превью по-прежнему открывает форму записи с тем же временем ──
        await s.eval(`(() => {
          const track = document.querySelector('.appt[data-id="vt-b2"]').closest('.schedule-track');
          const evt = new MouseEvent('mousemove', { clientX: ${targetX}, clientY: ${targetY}, bubbles: true });
          track.dispatchEvent(evt);
        })()`);
        await sleep(150);
        await s.eval(`(() => {
          const track = document.querySelector('.appt[data-id="vt-b2"]').closest('.schedule-track');
          const evt = new MouseEvent('click', { clientX: ${targetX}, clientY: ${targetY}, bubbles: true });
          track.dispatchEvent(evt);
        })()`);
        await sleep(150);
        const clickResult = await s.eval(`window.__openSlotBookingCalls`);
        check('Клик по превью по-прежнему вызывает openSlotBooking с 15-минутным снаппингом времени', Array.isArray(clickResult) && clickResult.length === 1 && /^13:1[05]$/.test(clickResult[0][3]), JSON.stringify(clickResult));
      });
    });
  });
} catch (err) {
  console.error('CRASH:', err);
  process.exitCode = 1;
}

const ok = summary();
if (!ok) process.exitCode = 1;
