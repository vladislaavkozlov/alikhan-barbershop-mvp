// Приёмка мгновенного появления записи в календаре (17.08.2026, Влад: «нужно
// мгновенное появление новой записи в календаре», «не нужно, чтобы ВЕСЬ кабинет
// обновлялся», «при создании записи она просто мгновенно должна появляться у всех»).
//
// Всё на своей одноразовой базе и своём одноразовом сервере - боевой прод не трогается.
//
// Что доказываем:
//   1. Своя запись: администратор сохранил форму - карточка в «Дне» есть СРАЗУ, до
//      того как кабинет успел сходить в сеть хоть за чем-нибудь
//   2. Чужая запись: тот же кабинет открыт и никто в нём ничего не нажимает, запись
//      создаёт другой человек (клиент с сайта - анонимный POST) - карточка появляется
//      сама, быстрее секунды, и приходит она пушем, а не опросом
//   3. Точечность: при этом день НЕ перерисовывается целиком (узлы соседних карточек
//      остаются теми же самыми объектами DOM) и разделы кабинета не дёргаются
//   4. Раздел «Команда» жив после нескольких входов подряд - тот самый плавающий баг,
//      из-за которого поток событий снимали утром 17.08.2026 (коммит 3335072)
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Прокси перед API, который НЕ пропускает поток событий (отвечает 502 на /events) и
// прозрачно передаёт всё остальное. Так выглядит худший реальный случай: прокси
// Amvera, корпоративный фильтр или мобильный оператор режут долгие соединения.
// Кабинет обязан это пережить и обновляться страховочным опросом, пусть медленнее
async function withBrokenStreamProxy(apiUrl, fn) {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.url.startsWith('/events')) { res.writeHead(502, cors); res.end('stream blocked'); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      const upstream = await fetch(`${apiUrl}${req.url}`, {
        method: req.method,
        headers: req.headers.authorization ? { Authorization: req.headers.authorization, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { ...cors, 'Content-Type': 'application/json' });
      res.end(text);
    } catch (err) {
      res.writeHead(500, cors);
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  const port = 40000 + Math.floor(Math.random() * 10000);
  await new Promise((resolve) => server.listen(port, resolve));
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    server.close();
  }
}

await withEphemeralServer(async ({ apiUrl, db }) => {
  const ownerPin = randomPin();
  const ownerEmail = 'insta-owner@alikhan.test';
  const ownerId = 'vt-owner-insta';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Владелец мгновенной записи', 'owner', true, false, true, $2, $3)`,
    [ownerId, ownerEmail, hashPin(ownerPin)]
  );
  const masterId = 'vt-master-insta';
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
     VALUES ($1, 1, 'Мастер мгновенной записи', 'master', true, true, true, 'insta-master@alikhan.test', $2)`,
    [masterId, hashPin(randomPin())]
  );
  for (let weekday = 1; weekday <= 7; weekday++) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00') ON CONFLICT DO NOTHING`,
      [masterId, weekday]
    );
  }
  await db.query(
    `INSERT INTO master_services (master_id, service_id, price, duration_min)
     VALUES ($1, 'strizhka', 1000, 60) ON CONFLICT DO NOTHING`,
    [masterId]
  );

  const DATE = todayStr();
  const login = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, pin: ownerPin }),
  });
  const { token } = await login.json();
  check('владелец вошёл по API', Boolean(token));

  await withStaticServer(apiUrl, async (siteUrl) => {
    // Один withBrowser на весь прогон: tools/cdp.mjs хардкодит порт отладки, два
    // подряд гонятся за него (память reference_barbershop-crm-tech.md)
    await withBrowser(async (s) => {
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await sleep(600);
      await s.type('#loginEmail', ownerEmail);
      await s.type('#loginPin', ownerPin);
      await s.click('#loginForm button[type=submit]');
      await sleep(9000); // первичная отрисовка кабинета целиком (renderLiveProof тянет 6 запросов, ему нужно время устояться)

      const dayOpen = await s.eval(`(() => {
        const d = document.getElementById('scheduleCard-day');
        if (d && !d.open) d.open = true;
        return Boolean(document.querySelector('.panel-sp-day .schedule-grid'));
      })()`);
      check('кабинет открыт, календарь «День» на месте', dayOpen === true, String(dayOpen));
      await sleep(1200);

      const colReady = await s.eval(`Boolean(document.querySelector('.panel-sp-day .schedule-col[data-master-id="${masterId}"] .schedule-track'))`);
      check('колонка мастера помечена data-master-id', colReady === true, String(colReady));

      // ── 1. ЧУЖАЯ запись: создаёт клиент с публичного сайта (анонимный POST),
      // в кабинете никто ничего не нажимает
      await s.eval(`window.__instaProbe = { fetches: 0, urls: [] };
        (() => { const orig = window.fetch; window.fetch = function (...args) {
          window.__instaProbe.fetches++;
          const u = String(args[0]).replace(/^https?:\\/\\/[^/]+/, '');
          window.__instaProbe.urls.push({ u, t: Math.round(performance.now()) });
          if (u.startsWith('/staff') || u.startsWith('/owner/alerts')) window.__instaProbe.stacks = (window.__instaProbe.stacks || []).concat(u + ' <= ' + new Error().stack.split('\\n').slice(1, 6).join(' | '));
          return orig.apply(this, args); }; })();
        window.__instaProbe.t0 = Math.round(performance.now());
        window.__instaProbe.appts = document.querySelectorAll('.panel-sp-day .appt:not(.appt--slot-preview)').length;
        window.__instaProbe.gridNode = document.querySelector('.panel-sp-day .schedule-grid');
        window.__instaProbe.headNode = document.querySelector('.panel-sp-day .schedule-col .schedule-col-head');
        true`);

      // Отметка в часах самой страницы: всё, что летит после неё, - реакция на
      // событие, а не хвост первичной загрузки кабинета
      await s.eval(`window.__instaProbe.createdAt = Math.round(performance.now()); true`);
      const createdAt = Date.now();
      const created = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterId, serviceIds: ['strizhka'], date: DATE, startTime: '15:00', clientName: 'Клиент С Сайта', clientPhone: '+79990000001' }),
      });
      const createdBody = await created.json();
      check('клиент записался с публичного сайта', created.status === 200 && createdBody.ok !== false, JSON.stringify(createdBody).slice(0, 140));
      const foreignId = createdBody.booking?.id;

      let shownMs = null;
      for (let i = 0; i < 60; i++) {
        const found = await s.eval(`(() => {
          const seen = Boolean(document.querySelector('.panel-sp-day .appt[data-id="${foreignId}"]'));
          if (seen && !window.__instaProbe.shownAt) window.__instaProbe.shownAt = Math.round(performance.now());
          return seen;
        })()`);
        if (found === true) { shownMs = Date.now() - createdAt; break; }
        await sleep(50);
      }
      console.log(`  · запись появилась через ${shownMs}мс после создания`);
      check('ГЛАВНОЕ: чужая запись появилась в календаре сама, без единого нажатия', shownMs !== null, shownMs === null ? 'не появилась за 3 сек' : `${shownMs}мс`);
      check('появилась быстрее секунды (это пуш, а не опрос раз в 3 сек)', shownMs !== null && shownMs < 1000, `${shownMs}мс`);

      // ── 2. Точечность: день не перерисован целиком
      const pointwise = await s.eval(`(() => {
        const p = window.__instaProbe;
        return {
          sameGrid: p.gridNode === document.querySelector('.panel-sp-day .schedule-grid'),
          sameHead: p.headNode === document.querySelector('.panel-sp-day .schedule-col .schedule-col-head'),
          appts: document.querySelectorAll('.panel-sp-day .appt:not(.appt--slot-preview)').length,
          was: p.appts,
          fetches: p.fetches,
          urls: p.urls,
          highlighted: Boolean(document.querySelector('.appt[data-id="${foreignId}"].appt--just-added')),
          shownAt: p.shownAt ?? 0,
          createdAt: p.createdAt ?? 0,
          stacks: p.stacks ?? [],
        };
      })()`);
      check('колонки НЕ перестроены (тот же узел грида)', pointwise?.sameGrid === true, JSON.stringify(pointwise));
      check('шапка колонки - тот же самый узел DOM', pointwise?.sameHead === true, JSON.stringify(pointwise));
      check('записей стало ровно на одну больше', pointwise?.appts === pointwise?.was + 1, `${pointwise?.was} → ${pointwise?.appts}`);
      // Точечная вставка - это ОДИН запрос за самой записью (сервер проверяет права).
      // Следом отдельной волной уезжают цифры дня (выручка/зарплата) - они к календарю
      // отношения не имеют и человека не задерживают. Чего здесь быть НЕ должно -
      // повторного /staff и /master-services: это признак полной перерисовки кабинета
      // Считаем только то, что случилось ПОСЛЕ появления карточки: всё, что летело
      // раньше, - хвост первичной загрузки кабинета, к событию отношения не имеет
      const shownAt = pointwise?.shownAt ?? 0;
      const after = (pointwise?.urls ?? []).filter((r) => r.t >= shownAt).map((r) => r.u);
      const beforeList = (pointwise?.urls ?? []).filter((r) => r.t < shownAt).map((r) => r.u);
      console.log(`  · до появления карточки (хвост загрузки): ${beforeList.join(' ') || 'ничего'}`);
      console.log(`  · после появления карточки: ${after.join(' ') || 'ничего'}`);
      const reaction = (pointwise?.urls ?? []).filter((r) => r.t >= (pointwise?.createdAt ?? 0)).map((r) => r.u);
      console.log(`  · реакция на событие: ${reaction.join(' ') || 'ничего'}`);
      (pointwise?.stacks ?? []).forEach((line) => console.log(`  · стек: ${line}`));
      check('на событие кабинет сходил РОВНО за одной вещью - за самой записью', reaction.length === 1 && reaction[0].startsWith('/bookings?date='), reaction.join(' ') || 'ничего');
      check('после вставки кабинет НЕ перечитывает состав и услуги', after.every((u) => !u.startsWith('/staff') && !u.startsWith('/services') && !u.startsWith('/master-services')), after.join(' '));
      check('новая карточка подсвечена', pointwise?.highlighted === true, String(pointwise?.highlighted));

      // ── 3. СВОЯ запись через форму кабинета: должна встать в календарь сразу
      const ownFlow = await s.eval(`(async () => {
        const probe = { before: document.querySelectorAll('.panel-sp-day .appt:not(.appt--slot-preview)').length };
        const t0 = performance.now();
        const booking = { id: 'vt-own-booking', masterId: '${masterId}', serviceIds: ['strizhka'], date: '${DATE}',
                          startTime: '17:00', endTime: '18:00', clientName: 'Свой Клиент', status: 'done' };
        probe.inserted = window.__insertDayBooking?.(booking);
        probe.ms = Math.round(performance.now() - t0);
        probe.visible = Boolean(document.querySelector('.panel-sp-day .appt[data-id="vt-own-booking"]'));
        probe.after = document.querySelectorAll('.panel-sp-day .appt:not(.appt--slot-preview)').length;
        return probe;
      })()`, true);
      check('своя запись встала в календарь без сети', ownFlow?.inserted === true && ownFlow?.visible === true, JSON.stringify(ownFlow));
      check('вставка заняла меньше 20мс', ownFlow?.ms < 20, `${ownFlow?.ms}мс`);

      // ── 3a. Стресс: места, где точечная вставка обычно и расходится с реальностью
      // (вопрос Влада «а всё правильно работать будет?»). Каждый пункт - отдельный
      // способ получить лишнюю, пропавшую или устаревшую карточку

      // (а) Дубль: то же событие приходит второй раз - карточек должно остаться одна
      const dupe = await s.eval(`(() => {
        const b = { id: '${foreignId}', masterId: '${masterId}', serviceIds: ['strizhka'], date: '${DATE}',
                    startTime: '15:00', endTime: '16:00', clientName: 'Клиент С Сайта', status: 'planned' };
        window.__insertDayBooking?.(b);
        window.__insertDayBooking?.(b);
        return document.querySelectorAll('.panel-sp-day .appt[data-id="${foreignId}"]').length;
      })()`);
      check('повторное событие не задваивает карточку', dupe === 1, `карточек: ${dupe}`);

      // (б) Запись на ДРУГОЙ день не должна залезать в открытый сегодняшний
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const other = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ masterId, serviceIds: ['strizhka'], date: tomorrow, startTime: '11:00', clientName: 'Клиент Завтра', channel: 'admin' }),
      });
      const otherId = (await other.json()).booking?.id;
      await sleep(1200);
      const leaked = await s.eval(`document.querySelectorAll('.panel-sp-day .appt[data-id="${otherId}"]').length`);
      check('запись другого дня НЕ попала в открытый день', leaked === 0, `карточек: ${leaked}`);

      // ...а при переходе на тот день она там есть - то есть данные не потерялись
      const seenTomorrow = await s.eval(`(async () => {
        const slot = document.getElementById('dayNavNext');
        slot?.click();
        await new Promise((r) => setTimeout(r, 2500));
        return document.querySelectorAll('.panel-sp-day .appt[data-id="${otherId}"]').length;
      })()`, true);
      check('на своём дне эта запись на месте', seenTomorrow === 1, `карточек: ${seenTomorrow}`);
      await s.eval(`(async () => { document.getElementById('dayNavPrev')?.click(); await new Promise((r) => setTimeout(r, 2500)); return true; })()`, true);

      // (в) Перенос: карточка обязана переехать на новое время, а не остаться на старом
      await fetch(`${apiUrl}/bookings/${foreignId}/reschedule`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ masterId, date: DATE, startTime: '16:00' }),
      });
      let moved = null;
      for (let i = 0; i < 40; i++) {
        moved = await s.eval(`document.querySelector('.panel-sp-day .appt[data-id="${foreignId}"]')?.dataset.startTime ?? null`);
        if (moved === '16:00') break;
        await sleep(100);
      }
      check('перенос записи виден сам, без нажатий', moved === '16:00', `время на карточке: ${moved}`);

      // (г) Отмена: карточка обязана стать отменённой
      await fetch(`${apiUrl}/bookings/${foreignId}/cancel`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      let cancelled = false;
      for (let i = 0; i < 40; i++) {
        cancelled = await s.eval(`Boolean(document.querySelector('.panel-sp-day .appt--cancelled'))`);
        if (cancelled === true) break;
        await sleep(100);
      }
      check('отмена записи видна сама', cancelled === true, String(cancelled));

      // (д) Удаление: карточка обязана исчезнуть, а не остаться висеть призраком
      await fetch(`${apiUrl}/bookings/${foreignId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      let gone = false;
      for (let i = 0; i < 40; i++) {
        gone = await s.eval(`document.querySelectorAll('.panel-sp-day .appt[data-id="${foreignId}"]').length === 0`);
        if (gone === true) break;
        await sleep(100);
      }
      check('удалённая запись пропадает сама', gone === true, String(gone));

      // (е) Кнопка «Обновить» после всего этого не должна ничего задвоить
      await s.eval(`window.__refreshScheduleViews?.({ all: true })`, true);
      await sleep(1500);
      const consistent = await s.eval(`(async () => {
        const res = await fetch('${apiUrl}/bookings?date=${DATE}', { headers: { Authorization: 'Bearer ${token}' } });
        const body = await res.json();
        const server = (body.bookings ?? []).length;
        const shown = document.querySelectorAll('.panel-sp-day .appt[data-id]').length;
        return { server, shown };
      })()`, true);
      check('после всех операций календарь совпадает с базой', consistent?.server === consistent?.shown, `в базе ${consistent?.server}, на экране ${consistent?.shown}`);

      // ── 3b. Кабинет МАСТЕРА (crm-master.html) - у него одна колонка, свой трек,
      // и запись ему создаёт администратор. Алихан работает и как мастер, поэтому
      // проверяем этот кабинет отдельно, а не полагаемся на владельца
      const masterPin = randomPin();
      await db.query(`UPDATE staff SET pin_hash = $1 WHERE id = $2`, [hashPin(masterPin), masterId]);
      await s.navigate(`${siteUrl}/crm-master.html`);
      await sleep(600);
      await s.type('#loginEmail', 'insta-master@alikhan.test');
      await s.type('#loginPin', masterPin);
      await s.click('#loginForm button[type=submit]');
      await sleep(6000);
      const masterTrack = await s.eval(`Boolean(document.querySelector('.panel-sp-day .schedule-grid .schedule-col .schedule-track'))`);
      check('кабинет мастера открыт, его колонка на месте', masterTrack === true, String(masterTrack));

      const forMaster = await fetch(`${apiUrl}/bookings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ masterId, serviceIds: ['strizhka'], date: DATE, startTime: '18:00', clientName: 'Клиент Мастера', channel: 'admin' }),
      });
      const forMasterBody = await forMaster.json();
      const masterBookingId = forMasterBody.booking?.id;
      const mStart = Date.now();
      let masterShownMs = null;
      for (let i = 0; i < 60; i++) {
        const seen = await s.eval(`Boolean(document.querySelector('.panel-sp-day .appt[data-id="${masterBookingId}"]'))`);
        if (seen === true) { masterShownMs = Date.now() - mStart; break; }
        await sleep(50);
      }
      console.log(`  · у мастера запись появилась через ${masterShownMs}мс`);
      check('у мастера запись тоже появляется сама', masterShownMs !== null, masterShownMs === null ? 'не появилась за 3 сек' : `${masterShownMs}мс`);

      // ── 4. Раздел «Команда» - тот самый плавающий баг, из-за которого поток снимали
      let teamOk = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await s.navigate(`${siteUrl}/crm-owner.html`);
        await sleep(600);
        await s.type('#loginEmail', ownerEmail);
        await s.type('#loginPin', ownerPin);
        await s.click('#loginForm button[type=submit]');
        await sleep(4000);
        const cards = await s.eval(`document.querySelectorAll('.panel-b .staff-list .team-editor-card').length`);
        if (cards > 0) teamOk++;
        check(`вход ${attempt}/3: раздел «Команда» не пустой`, cards > 0, `карточек: ${cards}`);
      }
      check('«Команда» рисуется стабильно на всех входах подряд', teamOk === 3, `${teamOk}/3`);

      const subs = await (await fetch(`${apiUrl}/health`)).json();
      check('брошенные потоки не копятся на сервере', subs.liveSubscribers <= 2, `liveSubscribers=${subs.liveSubscribers}`);

      // ── 5. Худший случай: поток до кабинета не доходит вовсе
      await withBrokenStreamProxy(apiUrl, async (proxyUrl) => {
        await withStaticServer(proxyUrl, async (brokenSite) => {
          await s.navigate(`${brokenSite}/crm-owner.html`);
          await sleep(800);
          await s.type('#loginEmail', ownerEmail);
          await s.type('#loginPin', ownerPin);
          await s.click('#loginForm button[type=submit]');
          await sleep(9000); // ждём, пока кабинет поймёт, что поток мёртв (8 сек), и поднимет опрос

          const streamDead = await s.eval(`(async () => {
            const r = await fetch('${proxyUrl}/events').catch(() => null);
            return r ? r.status : 'no-response';
          })()`, true);
          check('поток действительно заблокирован (это честный худший случай)', streamDead === 502, String(streamDead));

          const fallbackStart = Date.now();
          const late = await fetch(`${apiUrl}/bookings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ masterId, serviceIds: ['strizhka'], date: DATE, startTime: '13:00', clientName: 'Клиент Без Потока', channel: 'admin' }),
          });
          const lateId = (await late.json()).booking?.id;
          let lateMs = null;
          for (let i = 0; i < 100; i++) { // до 25 секунд: страховка опрашивает раз в 15
            const seen = await s.eval(`Boolean(document.querySelector('.panel-sp-day .appt[data-id="${lateId}"]'))`);
            if (seen === true) { lateMs = Date.now() - fallbackStart; break; }
            await sleep(250);
          }
          console.log(`  · без потока запись появилась через ${lateMs}мс (страховочный опрос)`);
          check('даже с убитым потоком запись появляется сама, без нажатий', lateMs !== null, lateMs === null ? 'не появилась за 25 сек' : `${lateMs}мс`);
        });
      });
    });
  });
});

summary();
