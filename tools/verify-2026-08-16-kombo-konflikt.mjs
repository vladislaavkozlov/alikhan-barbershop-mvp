// Живая проверка правила комплексной услуги (Влад, 16.08.2026: "если выбрать просто
// 'Борода' и 'Стрижка + борода', он позволит это сохранить... вообще можно выбрать
// 'борода' + 'бритье' + 'стрижка + борода'").
//
// Что проверяем настоящими кликами, а не вызовом функции:
//  1) на сайте клиента: борода → комплекс оставляет один комплекс; борода → бритьё →
//     комплекс тоже; и сумма в итоге считается по комплексу, а не с задвоением;
//  2) в форме CRM (владелец) - то же самое чекбоксами;
//  3) сервер отказывает противоречивому составу мимо формы - на записи с сайта, на
//     полной замене состава и на дописывании услуги к существующей записи.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KOMPLEKS = 'kompleks-strizhka-boroda';
const DATE = daysFromToday(4);

async function login(apiUrl, email, pin) {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  if (!res.ok) throw new Error(`логин ${email} → ${res.status}`);
  return (await res.json()).token;
}
async function api(apiUrl, path, method, token, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vc-owner', 1, 'QA Владелец', 'owner', true, false, true, 'vc-owner@alikhan.test', $1)`,
      [hashPin(ownerPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vc-master', 1, 'QA Мастер', 'master', true, true, true, 'vc-master@alikhan.test', $1)`,
      [hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min)
       SELECT 'vc-master', id, price, duration_min FROM services`
    );
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       SELECT 'vc-master', g, true, '10:00', '20:00' FROM generate_series(1, 7) g ON CONFLICT DO NOTHING`
    );
    const token = await login(apiUrl, 'vc-owner@alikhan.test', ownerPin);

    // ── Сервер: противоречивый состав не принимается ни одним входом
    const posted = await api(apiUrl, '/bookings', 'POST', null, {
      masterId: 'vc-master', serviceIds: ['boroda', KOMPLEKS], date: DATE, startTime: '12:00',
      clientName: 'Обход формы', clientPhone: '+79031112233',
    });
    check('POST /bookings отклоняет комплекс + бороду',
      posted.status === 400 && posted.data?.error === 'combo_conflict',
      `${posted.status} ${JSON.stringify(posted.data)}`);

    const ok = await api(apiUrl, '/bookings', 'POST', null, {
      masterId: 'vc-master', serviceIds: [KOMPLEKS], date: DATE, startTime: '12:00',
      clientName: 'Нормальная запись', clientPhone: '+79031112233',
    });
    const bookingId = ok.data?.booking?.id || ok.data?.id;
    check('обычная запись (только комплекс) создаётся', Boolean(bookingId), JSON.stringify(ok.data)?.slice(0, 160));

    const put = await api(apiUrl, `/bookings/${bookingId}/services`, 'PUT', token, {
      serviceIds: [KOMPLEKS, 'britie'],
    });
    check('PUT /services отклоняет комплекс + бритьё',
      put.status === 400 && put.data?.error === 'combo_conflict', `${put.status} ${JSON.stringify(put.data)}`);

    const patch = await api(apiUrl, `/bookings/${bookingId}/services`, 'PATCH', token, {
      serviceIds: ['firmennaya-okantovka'],
    });
    check('PATCH /services отклоняет дописывание окантовки к комплексу',
      patch.status === 400 && patch.data?.error === 'combo_conflict', `${patch.status} ${JSON.stringify(patch.data)}`);

    const putOk = await api(apiUrl, `/bookings/${bookingId}/services`, 'PUT', token, {
      serviceIds: [KOMPLEKS, 'vosk'],
    });
    check('состав без противоречия по-прежнему сохраняется (комплекс + воск)',
      putOk.status === 200 && putOk.data?.ok !== false, `${putOk.status} ${JSON.stringify(putOk.data)?.slice(0, 160)}`);

    // ── Живые клики
    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        // 1. Публичный сайт
        await s.navigate(`${siteUrl}/index.html`);
        await sleep(1800);
        for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.querySelector('#master-grid .opt-availability'))`)); i++) {
          await sleep(150);
        }
        await s.eval(
          `[...document.querySelectorAll('#master-grid .option-card')]
             .find((n) => n.querySelector('.opt-name')?.textContent.trim() === 'QA Мастер')?.click()`
        );
        await sleep(800);

        const clickService = async (name) => {
          await s.eval(
            `[...document.querySelectorAll('#service-grid .option-card')]
               .find((n) => n.querySelector('.opt-name')?.textContent.trim() === ${JSON.stringify(name)})?.click()`
          );
          await sleep(250);
        };
        const chosen = async () =>
          await s.eval(
            `[...document.querySelectorAll('#service-grid .option-card')]
               .filter((n) => n.getAttribute('aria-pressed') === 'true')
               .map((n) => n.querySelector('.opt-name').textContent.trim())`
          );

        await clickService('Борода');
        await clickService('Комплекс стрижка+борода');
        const afterAbsorb = await chosen();
        check('сайт: борода → комплекс оставляет только комплекс',
          JSON.stringify(afterAbsorb) === JSON.stringify(['Комплекс стрижка+борода']),
          (afterAbsorb || []).join(' + '));

        // Сбрасываем и повторяем набор из жалобы целиком
        await clickService('Комплекс стрижка+борода');
        await clickService('Борода');
        await clickService('Бритьё');
        await clickService('Комплекс стрижка+борода');
        const afterTriple = await chosen();
        check('сайт: борода + бритьё + комплекс схлопывается в один комплекс',
          JSON.stringify(afterTriple) === JSON.stringify(['Комплекс стрижка+борода']),
          (afterTriple || []).join(' + '));

        const summaryText = await s.eval(`document.getElementById('service-summary')?.textContent?.trim() ?? ''`);
        check('сайт: в сумме нет задвоенной цены (3500, не 6600)',
          /3\s?500/.test(summaryText || '') && !/6\s?600/.test(summaryText || ''), `итог: ${summaryText}`);

        // Стрижка → бритьё → борода: комплекс собирается сам, бритьё не остаётся рядом
        await clickService('Комплекс стрижка+борода');
        await clickService('Стрижка');
        await clickService('Бритьё');
        await clickService('Борода');
        const afterMerge = await chosen();
        check('сайт: стрижка → бритьё → борода даёт один комплекс',
          JSON.stringify(afterMerge) === JSON.stringify(['Комплекс стрижка+борода']),
          (afterMerge || []).join(' + '));

        // 2. Форма CRM владельца
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.getElementById('loginEmail'))`)); i++) await sleep(150);
        await s.eval(
          `document.getElementById('loginEmail').value = 'vc-owner@alikhan.test';
           document.getElementById('loginPin').value = '${ownerPin}';
           document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click()`
        );
        await sleep(2500);
        await s.eval(`window.openManualBooking?.()`);
        await sleep(900);

        const checkService = async (name) => {
          await s.eval(
            `(() => {
               const label = [...document.querySelectorAll('#wfServicePicker .service-check')]
                 .find((n) => n.querySelector('.sc-name')?.textContent.trim() === ${JSON.stringify(name)});
               const input = label?.querySelector('input');
               if (!input || input.disabled) return false;
               input.checked = !input.checked;
               input.dispatchEvent(new Event('change', { bubbles: true }));
               return true;
             })()`
          );
          await sleep(250);
        };
        const crmChosen = async () =>
          await s.eval(
            `[...document.querySelectorAll('#wfServicePicker .service-check')]
               .filter((n) => n.querySelector('input')?.checked)
               .map((n) => n.querySelector('.sc-name').textContent.trim())`
          );

        await checkService('Борода');
        await checkService('Бритьё');
        await checkService('Комплекс стрижка+борода');
        const crmAfter = await crmChosen();
        check('CRM: борода + бритьё + комплекс схлопывается в один комплекс',
          JSON.stringify(crmAfter) === JSON.stringify(['Комплекс стрижка+борода']),
          (crmAfter || []).join(' + '));

        await checkService('Комплекс стрижка+борода');
        await checkService('Стрижка');
        await checkService('Бритьё');
        await checkService('Борода');
        const crmMerge = await crmChosen();
        check('CRM: стрижка → бритьё → борода даёт один комплекс',
          JSON.stringify(crmMerge) === JSON.stringify(['Комплекс стрижка+борода']),
          (crmMerge || []).join(' + '));

        // 3. Запись, у которой противоречие УЖЕ есть (созданные до этой правки) -
        // форма должна прямо сказать, что снять, а не падать при сохранении
        await db.query(`INSERT INTO booking_services (booking_id, service_id) VALUES ($1, 'boroda') ON CONFLICT DO NOTHING`, [bookingId]);
        await s.eval(
          `window.openBookingEdit?.({ dataset: {
             id: '${bookingId}', client: 'Нормальная запись', phone: '+79031112233',
             masterId: 'vc-master', master: 'QA Мастер',
             serviceIds: '${KOMPLEKS},boroda', date: '${DATE}', startTime: '12:00',
             realStatus: 'planned', noshowStreak: '0', requiresPrepayment: 'false',
             actualPrice: '', staffComment: '',
           }, classList: { add() {}, remove() {} } })`
        );
        await sleep(900);
        const warn = await s.eval(`document.getElementById('wfResult')?.textContent?.trim() ?? ''`);
        check('старая противоречивая запись открывается с понятной подсказкой',
          /снимите лишнюю галочку/i.test(warn), `текст: ${warn}`);
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exit(1);
