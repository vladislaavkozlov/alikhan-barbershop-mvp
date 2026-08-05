// Живая проверка Окна 23 - отмена уже одобренной многодневной заявки на
// отгул/отпуск целиком, из кабинета владельца.
//
// Задача E промпта Окна 29 (05.08.2026) - переписано на автономность (было
// tools/verify-2026-08-04-okno23-otmena-otgula.mjs, аудит 05.08 нашёл эту дыру):
// прогон падал на первом же логине qa-w23-owner@alikhan.test - аккаунт заводился
// вручную в чужой сессии и не пересоздавался. Теперь весь стенд свой
// (tools/verify-lib.mjs), qa-w23-owner/qa-w23-master заводятся прямым INSERT в
// staff (тем же hashPin(), что server.mjs) в setup этого же прогона - PIN случайный
// на прогон, не литерал в публичном репозитории. Даты диапазона - тоже смещения от
// сегодняшнего дня (daysFromToday), не литералы календаря, чтобы через несколько
// месяцев "далеко в будущем" не стало "уже прошло".
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(apiUrl, email, pin) {
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  if (!res.ok) throw new Error(`логин ${email} → ${res.status}`);
  return (await res.json()).token;
}
async function api(apiUrl, path, method, token, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// Диапазон под этот прогон - три подряд идущих дня далеко в будущем (смещение от
// сегодня, не литерал), чтобы не пересечься ни с реальными бронями, ни с фикстурами
// других прогонов.
const D1 = daysFromToday(130);
const D2 = daysFromToday(131);
const D3 = daysFromToday(132);
const PENDING_DATE = daysFromToday(140);

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const ownerPin = randomPin();
  const masterPin = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('qa-w23-owner', NULL, 'QA Тест Окно 23 Владелец (verify, эфемерная база)', 'owner', true, false, true, 'qa-w23-owner@alikhan.test', $1),
     ('qa-w23-master', NULL, 'QA Тест Окно 23 Мастер (verify, эфемерная база)', 'master', true, true, true, 'qa-w23-master@alikhan.test', $2)`,
    [hashPin(ownerPin), hashPin(masterPin)]
  );

  const ownerToken = await login(apiUrl, 'qa-w23-owner@alikhan.test', ownerPin);
  const masterToken = await login(apiUrl, 'qa-w23-master@alikhan.test', masterPin);

  const created = await api(apiUrl, '/schedule-requests', 'POST', masterToken, {
    requestType: 'day_off',
    category: 'otpusk',
    dateFrom: D1,
    dateTo: D3,
    masterComment: 'CDP-прогон Окна 23 (автономный, Задача E Окна 29)',
  });
  const approvedId = created.data.id;
  await api(apiUrl, `/schedule-requests/${approvedId}/decision`, 'PATCH', ownerToken, { decision: 'approved' });

  const pendingRes = await api(apiUrl, '/schedule-requests', 'POST', masterToken, {
    requestType: 'day_off',
    category: 'otgul',
    dateFrom: PENDING_DATE,
    dateTo: PENDING_DATE,
    masterComment: 'CDP-прогон Окна 23 (остаётся pending)',
  });
  const pendingId = pendingRes.data.id;

  console.log(`фикстуры: одобренная заявка id=${approvedId} (${D1}…${D3}), pending id=${pendingId}`);

  // Контроль: до отмены все три даты диапазона реально заблокированы.
  const beforeRange = await api(apiUrl, `/schedule-range?masterId=qa-w23-master&from=${D1}&to=${D3}`, 'GET', ownerToken);
  check(
    'до отмены: все 3 даты диапазона помечены выходными (isDayOff=true)',
    Array.isArray(beforeRange.data) && beforeRange.data.every((d) => d.isDayOff === true),
    JSON.stringify(beforeRange.data)
  );

  await withStaticServer(apiUrl, async (base) => {
    await withBrowser(async (s) => {
      await s.setViewport(1280, 1000, false);
      await s.navigate(`${base}/crm-owner.html`);
      await sleep(700);

      await s.type('#loginEmail', 'qa-w23-owner@alikhan.test');
      await s.type('#loginPin', ownerPin);
      await s.click('#loginForm button[type="submit"]');
      await sleep(2500);

      const blockExists = await s.eval(`!!document.getElementById('ownerReqList')`);
      check('блок «Заявки мастеров на изменение графика» есть на странице владельца', blockExists === true);

      const loaded = await s.eval(`document.querySelectorAll('#ownerReqList [data-req-row]').length > 0`);
      check('список заявок наполнился реальными строками из API', loaded === true);

      const approvedRow = `#ownerReqList [data-req-row="${approvedId}"]`;
      const rowText = await s.eval(`document.querySelector('${approvedRow}')?.innerText || ''`);
      check('строка одобренной заявки показывает период и статус «Одобрено»', /Одобрено/.test(rowText) && rowText.includes(D1), rowText);

      const hasCancelBtn = await s.eval(`!!document.querySelector('${approvedRow} [data-cancel-req]')`);
      check('у одобренной заявки есть кнопка «Отменить»', hasCancelBtn === true);

      const pendingHasBtn = await s.eval(`!!document.querySelector('#ownerReqList [data-req-row="${pendingId}"] [data-cancel-req]')`);
      check('у заявки в статусе «На рассмотрении» кнопки «Отменить» НЕТ (отменять нечего)', pendingHasBtn === false);

      // Шаг 1 подтверждения
      await s.eval(`document.querySelector('${approvedRow} [data-cancel-req]').click()`);
      await sleep(300);
      const confirmShown = await s.eval(`!!document.querySelector('${approvedRow} [data-confirm-yes]') && !!document.querySelector('${approvedRow} [data-confirm-no]')`);
      check('клик по «Отменить» показывает подтверждение (Да, отменить / Нет), а не отменяет сразу', confirmShown === true);

      // Отказ от подтверждения ничего не меняет
      await s.eval(`document.querySelector('${approvedRow} [data-confirm-no]').click()`);
      await sleep(300);
      const backToButton = await s.eval(`!!document.querySelector('${approvedRow} [data-cancel-req]') && !document.querySelector('${approvedRow} [data-confirm-yes]')`);
      check('«Нет» возвращает кнопку «Отменить», запрос не уходит', backToButton === true);
      const stillApproved = await api(apiUrl, `/schedule-requests?masterId=qa-w23-master`, 'GET', ownerToken);
      check(
        'после отказа заявка всё ещё approved на сервере',
        stillApproved.data.find((r) => r.id === approvedId)?.status === 'approved'
      );

      // Подтверждаем отмену
      await s.eval(`document.querySelector('${approvedRow} [data-cancel-req]').click()`);
      await sleep(300);
      await s.eval(`document.querySelector('${approvedRow} [data-confirm-yes]').click()`);
      await sleep(2000);

      const afterText = await s.eval(`document.querySelector('${approvedRow}')?.innerText || ''`);
      check('после подтверждения строка показывает «Одобрение отменено»', /Одобрение отменено/.test(afterText), afterText);
      const btnGone = await s.eval(`!!document.querySelector('${approvedRow} [data-cancel-req]')`);
      check('кнопка «Отменить» у отменённой заявки исчезла (повторно нажать нельзя)', btnGone === false);

      // behavior:'instant' обязателен - при плавном скролле скриншот снимается на полпути
      await s.eval(`document.getElementById('ownerReqList').scrollIntoView({block:'center',behavior:'instant'})`);
      await sleep(400);
      await s.screenshot('/tmp/okno23-owner-requests.png');
      console.log('скриншот: /tmp/okno23-owner-requests.png');
    });
  });

  // ── проверка эффекта в базе, не только на экране ──────────────────────────
  // "Вернулись к стандартному графику" проверяем по ОТСУТСТВИЮ разовой правки на
  // дату (GET /schedule отдаёт id: null, когда строки schedule_shifts нет и день
  // посчитан резолвером), а не по isDayOff=false - если дата диапазона попадёт на
  // день, который у мастера и так выходной по недельному шаблону, isDayOff=true
  // там останется правильным ответом. id===null инвариантен к этому.
  for (const date of [D1, D2, D3]) {
    const day = await api(apiUrl, `/schedule?masterId=qa-w23-master&date=${date}`, 'GET', ownerToken);
    check(
      `после отмены на ${date} не осталось разовой правки - день считает стандартный график`,
      Array.isArray(day.data) && day.data.length === 1 && day.data[0].id === null,
      JSON.stringify(day.data)
    );
  }

  const afterList = await api(apiUrl, '/schedule-requests?masterId=qa-w23-master', 'GET', ownerToken);
  check('статус заявки в базе = cancelled', afterList.data.find((r) => r.id === approvedId)?.status === 'cancelled');
  check('pending-заявка отменой не задета', afterList.data.find((r) => r.id === pendingId)?.status === 'pending');

  const repeat = await api(apiUrl, `/schedule-requests/${approvedId}/cancel`, 'PATCH', ownerToken);
  check('повторная отмена той же заявки отбита 409', repeat.status === 409, `HTTP ${repeat.status}`);
});
} catch (err) {
  crashed = true;
  console.error('Прогон упал с ошибкой:', err);
}
process.exit(summary() && !crashed ? 0 : 1);
