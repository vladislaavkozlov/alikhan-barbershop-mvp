// Приёмка понятной ошибки графика (17.08.2026, вечер, Влад по живому экрану: «в чём
// здесь конкретно ошибка? Что перерыв вне рабочего дня? - тогда так и нужно написать в
// ошибке в конкретном случае» + второй случай от него же: «перерыв если ставить,
// например с 5:15 до 5:15 тоже такая же ошибка возникает»).
//
// Всё на своей одноразовой базе и своём одноразовом сервере - боевой прод не трогается.
//
// Что доказываем на РЕАЛЬНОЙ форме «Команда → График», кликами:
//   1. Случай Влада №1 (рабочий день 00:00-08:00, перерыв 13:00-14:00) - на экране
//      названы день, часы перерыва, часы рабочего дня и что нужно сделать
//   2. Случай Влада №2 (перерыв 05:15-05:15) - ДРУГАЯ фраза, про конец позже начала,
//      а не про «вне графика»
//   3. Всплывающее окно ровно одно (было два, второе - общее «Повторите попытку»)
//   4. Правильный график после этого сохраняется, ошибка уходит
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withEphemeralServer(async ({ apiUrl, db }) => {
  const ownerPin = randomPin();
  const ownerEmail = 'err-owner@alikhan.test';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ('vt-owner-err', 1, 'Владелец', 'owner', true, false, true, $1, $2)`,
    [ownerEmail, hashPin(ownerPin)]
  );
  const masterId = 'vt-master-err';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Мастер графика', 'master', true, true, true, 'err-master@alikhan.test', $2)`,
    [masterId, hashPin(randomPin())]
  );
  await db.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min)
     VALUES ($1, 'strizhka', 1000, 60) ON CONFLICT DO NOTHING`,
    [masterId]
  );
  for (let wd = 1; wd <= 7; wd++) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00')`,
      [masterId, wd]
    );
  }

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await sleep(700);
      await s.type('#loginEmail', ownerEmail);
      await s.type('#loginPin', ownerPin);
      await s.click('#loginForm button[type=submit]');
      await sleep(9000);

      const opened = await s.eval(`(() => {
        document.querySelector('[data-nav-target="team"], [data-panel="team"], #navTeam')?.click();
        const card = document.querySelector('.staff-card[data-staff-id="${masterId}"]');
        if (card && !card.open) card.open = true;
        return Boolean(card);
      })()`);
      check('карточка мастера в «Команде» открыта', opened === true, String(opened));
      await sleep(2500);

      // Ставит значения так же, как человек: открыть список - выбрать значение
      const setTime = async (field, value) => s.eval(`(() => {
        const wrap = document.getElementById('weekly-${masterId}-3-${field}');
        if (!wrap) return null;
        wrap.querySelector('.custom-select-trigger').click();
        [...wrap.querySelectorAll('.custom-select-option')].find((o) => o.dataset.value === '${value}')?.click();
        return wrap.dataset.value;
      })()`);
      const enableBreak = await s.eval(`(() => {
        const t = document.getElementById('weekly-${masterId}-3-breakOn');
        if (t && !t.checked) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); }
        return Boolean(t?.checked);
      })()`);
      check('перерыв в среде включён', enableBreak === true, String(enableBreak));

      // ── Случай Влада №1: рабочий день 00:00-08:00, перерыв 13:00-14:00 ─────────
      await setTime('start', '00:00');
      await setTime('end', '08:00');
      await setTime('breakStart', '13:00');
      await setTime('breakEnd', '14:00');
      await s.eval(`window.__toastProbe = []; true`);
      await s.eval(`document.querySelector('.staff-card[data-staff-id="${masterId}"] [data-save]')?.click(); true`);
      await sleep(2500);

      const case1 = await s.eval(`(() => {
        const toasts = [...document.querySelectorAll('.crm-toast')].map((t) => t.textContent.trim());
        const note = document.getElementById('weekly-${masterId}-note')?.textContent?.trim() ?? '';
        return { toasts, count: toasts.length, note };
      })()`);
      console.log('  · экран после случая №1:', JSON.stringify(case1, null, 1));
      const text1 = (case1?.toasts ?? []).join(' | ');
      check('ГЛАВНОЕ: сказано, что перерыв вне рабочего дня, с обоими интервалами', /перерыв 13:00-14:00/.test(text1) && /вне рабочего дня 00:00-08:00/.test(text1), text1);
      check('назван конкретный день недели', /Среда/.test(text1), text1);
      check('сказано, что делать', /внутри рабочего времени/.test(text1), text1);
      check('всплывающее окно ровно одно (было два)', case1?.count === 1, JSON.stringify(case1?.toasts));
      check('та же причина осталась в строке под кнопкой графика', /вне рабочего дня/.test(case1?.note ?? ''), case1?.note);
      check('в тексте нет прежнего общего «Повторите попытку»', !/Повторите попытку/.test(text1), text1);

      // ── Случай Влада №2: перерыв 05:15-05:15 ──────────────────────────────────
      await s.eval(`document.querySelectorAll('.crm-toast .crm-toast-close, .crm-toast button').forEach((b) => b.click()); true`);
      await sleep(600);
      await setTime('breakStart', '05:15');
      await setTime('breakEnd', '05:15');
      await s.eval(`document.querySelector('.staff-card[data-staff-id="${masterId}"] [data-save]')?.click(); true`);
      await sleep(2500);
      const case2 = await s.eval(`(() => {
        const toasts = [...document.querySelectorAll('.crm-toast')].map((t) => t.textContent.trim());
        return { toasts, count: toasts.length };
      })()`);
      console.log('  · экран после случая №2:', JSON.stringify(case2, null, 1));
      const text2 = (case2?.toasts ?? []).join(' | ');
      check('ГЛАВНОЕ: про 05:15-05:15 сказано, что конец перерыва должен быть позже начала', /перерыв стоит с 05:15 до 05:15/.test(text2) && /конец перерыва должен быть позже начала/.test(text2), text2);
      check('и это НЕ та же фраза, что про «вне рабочего дня»', !/вне рабочего дня/.test(text2), text2);
      check('снова ровно одно окно', case2?.count === 1, JSON.stringify(case2?.toasts));

      // ── Правильный график сохраняется ─────────────────────────────────────────
      await s.eval(`document.querySelectorAll('.crm-toast .crm-toast-close, .crm-toast button').forEach((b) => b.click()); true`);
      await sleep(600);
      await setTime('breakStart', '05:15');
      await setTime('breakEnd', '06:00');
      await s.eval(`document.querySelector('.staff-card[data-staff-id="${masterId}"] [data-save]')?.click(); true`);
      await sleep(3500);
      const saved = await (await fetch(`${apiUrl}/master-weekly-schedule?masterId=${masterId}`, {
        headers: { Authorization: `Bearer ${(await (await fetch(`${apiUrl}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ownerEmail, pin: ownerPin }) })).json()).token}` },
      })).json();
      const wed = (saved.weekly ?? saved).find?.((r) => r.weekday === 3);
      check('ГЛАВНОЕ: исправленный график сохраняется (Ср 00:00-08:00, перерыв 05:15-06:00)', wed?.workStart === '00:00' && wed?.workEnd === '08:00' && wed?.breakStart === '05:15' && wed?.breakEnd === '06:00', JSON.stringify(wed));
      const afterOk = await s.eval(`(() => {
        const toasts = [...document.querySelectorAll('.crm-toast')].map((t) => t.textContent.trim());
        return { toasts, note: document.getElementById('weekly-${masterId}-note')?.textContent?.trim() ?? '' };
      })()`);
      console.log('  · экран после успешного сохранения:', JSON.stringify(afterOk, null, 1));
      check('после успеха на экране нет старой ошибки', !/вне рабочего дня|позже начала/.test(JSON.stringify(afterOk)), JSON.stringify(afterOk));
    });
  });
});

process.exit(summary() ? 0 : 1);
