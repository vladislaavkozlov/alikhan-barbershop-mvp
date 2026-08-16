// Живая проверка трёх правок карточки сотрудника (Влад, 16.08.2026):
//  1) тумблер "Показывать профиль на сайте" переключается даже у снятого с приёма и
//     будит кнопку сохранения (раньше был неактивен и молчал);
//  2) рабочая неделя НА ПРОСМОТР рисуется теми же иконками дней, что и на
//     редактировании, а не списком "Пн: выходной";
//  3) недоступный тумблер показывает СВОЁ состояние: включённый выглядит включённым,
//     только приглушённо (управляющий смотрит карточку владельца).
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    const managerPin = randomPin();
    const masterPin = randomPin();

    // Защищённый владелец в базе уже есть из сида - второго завести нельзя
    // (уникальный индекс staff_one_protected_owner_idx), поэтому берём его
    const owner = (await db.query(`SELECT id FROM staff WHERE protected_owner = true`)).rows[0];
    await db.query(
      `UPDATE staff SET employed = true, provides_services = true, location_id = 1,
              email = 'kv-owner@alikhan.test', pin_hash = $2, has_system_access = true, role = 'owner'
       WHERE id = $1`,
      [owner.id, hashPin(ownerPin)]
    );
    // Управляющему видны только те, кто либо не принимает клиентов, либо имеет график
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT $1, g, true, '10:00', '20:00' FROM generate_series(1, 7) g ON CONFLICT DO NOTHING`,
      [owner.id]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('kv-manager', 1, 'QA Управляющий', 'manager', true, false, true, 'kv-manager@alikhan.test', $1)`,
      [hashPin(managerPin)]
    );
    // Мастер СНЯТ с приёма - именно у него тумблер витрины был мёртвым
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('kv-master', 1, 'QA Мастер', 'master', true, false, true, 'kv-master@alikhan.test', $1)`,
      [hashPin(masterPin)]
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end, break_start, break_end)
       VALUES ('kv-master', 1, false, null, null, null, null),
              ('kv-master', 2, false, null, null, null, null),
              ('kv-master', 3, true, '10:00', '20:00', '13:00', '14:00'),
              ('kv-master', 4, true, '10:00', '20:00', '13:00', '14:00'),
              ('kv-master', 5, true, '10:00', '20:00', '13:00', '14:00'),
              ('kv-master', 6, true, '10:00', '20:00', null, null),
              ('kv-master', 7, true, '10:00', '20:00', null, null)`
    );

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        const login = async (page, email, pin) => {
          await s.setViewport(1400, 950);
          await s.navigate(`${siteUrl}/${page}`);
          for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.getElementById('loginEmail'))`)); i++) await sleep(150);
          await s.eval(
            `document.getElementById('loginEmail').value = ${JSON.stringify(email)};
             document.getElementById('loginPin').value = ${JSON.stringify(pin)};
             document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click()`
          );
          await sleep(3200);
          await s.setViewport(1400, 950);
        };
        const openTeam = async () => {
          await s.eval(
            `[...document.querySelectorAll('button, a, [role=button]')].find((n) => n.textContent.trim() === 'Команда')?.click()`
          );
          await sleep(1500);
        };

        // ── 1. Кабинет мастера: свой график на просмотр
        await login('crm-master.html', 'kv-master@alikhan.test', masterPin);
        const week = await s.eval(
          `(() => {
             const box = document.getElementById('weeklyEditor-self');
             if (!box) return { missing: true };
             return {
               icons: [...box.querySelectorAll('.weekday-icon')].map((n) => n.textContent.trim()),
               working: [...box.querySelectorAll('.weekday-icon.is-working')].map((n) => n.textContent.trim()),
               plainList: box.innerText.includes('Пн: выходной'),
             };
           })()`
        );
        check('мастер видит неделю иконками Пн-Вс, а не списком',
          JSON.stringify(week?.icons) === JSON.stringify(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']) && week?.plainList === false,
          JSON.stringify(week));
        check('выходные и рабочие дни различаются на самих иконках',
          JSON.stringify(week?.working) === JSON.stringify(['Ср', 'Чт', 'Пт', 'Сб', 'Вс']), JSON.stringify(week?.working));

        await s.eval(`document.querySelector('#weeklyEditor-self .weekday-icon[data-weekday="3"]')?.click()`);
        await sleep(400);
        const opened = await s.eval(
          `(() => {
             const p = document.querySelector('#weeklyEditor-self .weekly-day-panel.is-open');
             return p ? p.innerText.replace(/\\s+/g, ' ').trim() : null;
           })()`
        );
        check('клик по дню раскрывает панель с часами и перерывом',
          /Среда/.test(opened || '') && /10:00–20:00/.test(opened || '') && /перерыв 13:00–14:00/.test(opened || ''),
          `панель: ${opened}`);

        // ── 2. Владелец: тумблер витрины у снятого с приёма
        await login('crm-owner.html', 'kv-owner@alikhan.test', ownerPin);
        await openTeam();
        const before = await s.eval(
          `(() => {
             const card = document.querySelector('.team-editor-card[data-staff-id="kv-master"]');
             if (!card) return { missing: true };
             card.open = true;
             const t = card.querySelector('[name="publicProfileEnabled"]');
             return {
               disabled: t.disabled,
               hint: t.closest('.toggle-row')?.querySelector('.tr-sub')?.textContent?.trim() ?? '',
               save: card.querySelector('[data-save]')?.disabled,
             };
           })()`
        );
        check('тумблер витрины у снятого с приёма доступен', before?.disabled === false, JSON.stringify(before));
        check('подпись объясняет, почему на сайте его пока нет',
          /снят с приёма/i.test(before?.hint || ''), `подпись: ${before?.hint}`);

        await s.eval(
          `(() => {
             const card = document.querySelector('.team-editor-card[data-staff-id="kv-master"]');
             const t = card.querySelector('[name="publicProfileEnabled"]');
             t.checked = !t.checked;
             t.dispatchEvent(new Event('change', { bubbles: true }));
           })()`
        );
        await sleep(400);
        const woke = await s.eval(`document.querySelector('.team-editor-card[data-staff-id="kv-master"] [data-save]')?.disabled`);
        check('переключение будит кнопку "Сохранить изменения"', woke === false, `disabled=${woke}`);

        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="kv-master"] [data-save]')?.click()`);
        await sleep(2500);
        const saved = (await db.query(`SELECT public_profile_enabled FROM staff WHERE id = 'kv-master'`)).rows[0];
        check('значение сохранилось в базе', saved.public_profile_enabled === true,
          `public_profile_enabled=${saved.public_profile_enabled}`);

        // Чужая карточка на просмотр у владельца - тоже иконки, не список
        const otherWeek = await s.eval(
          `(() => {
             const box = document.getElementById('weeklyEditor-kv-master');
             return box ? { icons: box.querySelectorAll('.weekday-icon').length, plainList: box.innerText.includes('Пн: выходной') } : { missing: true };
           })()`
        );
        check('в карточке сотрудника неделя тоже иконками',
          otherWeek?.icons === 7 && otherWeek?.plainList === false, JSON.stringify(otherWeek));

        // ── 3. Управляющий смотрит карточку владельца: менять нельзя, но видно верно
        await login('crm-owner.html', 'kv-manager@alikhan.test', managerPin);
        await openTeam();
        const locked = await s.eval(
          `(() => {
             const card = document.querySelector('.team-editor-card[data-staff-id=${JSON.stringify(owner.id)}]');
             if (!card) return { missing: true };
             card.open = true;
             const read = (name) => {
               const input = card.querySelector('[name="' + name + '"]');
               if (!input) return null;
               const knob = input.parentElement.querySelector('.knob');
               const track = input.parentElement.querySelector('.track');
               return {
                 checked: input.checked,
                 disabled: input.disabled,
                 knobShifted: getComputedStyle(knob).transform !== 'none',
                 trackGreen: /111, 174, 124/.test(getComputedStyle(track).backgroundColor),
                 rowDimmed: Number(getComputedStyle(input.closest('.team-toggle-row')).opacity) < 1,
               };
             };
             return { employed: read('employed'), provides: read('providesServices') };
           })()`
        );
        for (const [field, title] of [['employed', 'Работает в компании'], ['provides', 'Принимает клиентов']]) {
          const t = locked?.[field];
          check(`"${title}" у владельца: менять нельзя, но видно что включено`,
            t?.checked === true && t?.disabled === true && t?.knobShifted === true && t?.trackGreen === true && t?.rowDimmed === true,
            JSON.stringify(t));
        }
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exit(1);
