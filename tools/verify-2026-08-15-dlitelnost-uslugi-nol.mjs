// Живая проверка фикса бага P2 (Влад, 15.08.2026): в карточке сотрудника
// («Команда» → услуга → длительность 0 минут → «Сохранить изменения») система
// показывала «Сохранено», ошибки не было, а после перезагрузки значение молча
// возвращалось к каталожным 60 минутам.
//
// Стенд полностью свой (tools/verify-lib.mjs): эфемерная база + свой сервер + своя
// статика, QA-владелец и QA-мастер заводятся прямым INSERT в staff тем же hashPin(),
// что и server.mjs, PIN случайный на прогон. Проверяем не 200-ответ роута, а сам
// механизм: текст ошибки в карточке, подсветку поля, отсутствие слова «Сохранено» и
// РЕАЛЬНОЕ содержимое master_services.duration_min после попытки.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const OWNER_EMAIL = 'qa-w-duration-owner@alikhan.test';
const MASTER_ID = 'qa-w-duration-master';

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const ownerPin = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('qa-w-duration-owner', NULL, 'QA Длительность Владелец (verify, эфемерная база)', 'owner', true, false, true, $1, $2),
     ($3, NULL, 'QA Длительность Мастер (verify, эфемерная база)', 'master', true, true, true, 'qa-w-duration-master@alikhan.test', $4)`,
    [OWNER_EMAIL, hashPin(ownerPin), MASTER_ID, hashPin(randomPin())]
  );
  // Услуга берётся из каталога, засеянного миграциями - назначаем её мастеру с
  // длительностью 60 минут, ровно как в сценарии Влада
  const service = (await db.query('SELECT id, name FROM services ORDER BY id LIMIT 1')).rows[0];
  await db.query(
    'INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, 1000, 60)',
    [MASTER_ID, service.id]
  );
  console.log(`фикстура: мастер ${MASTER_ID}, услуга "${service.name}" (${service.id}), длительность 60 мин`);

  const durationInDb = async () =>
    (await db.query('SELECT duration_min FROM master_services WHERE master_id = $1 AND service_id = $2', [MASTER_ID, service.id]))
      .rows[0]?.duration_min ?? null;

  // ── серверная половина: тот же ввод прямым запросом, мимо интерфейса ──
  const loginRes = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, pin: ownerPin }),
  });
  const ownerToken = (await loginRes.json()).token;
  const putDuration = async (durationMin) => {
    const res = await fetch(`${apiUrl}/master-services/${MASTER_ID}/${service.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify(durationMin === undefined ? { enabled: true } : { enabled: true, durationMin }),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  for (const bad of [0, -10, 1.5, null, 'abc']) {
    const out = await putDuration(bad);
    check(`PUT с длительностью ${JSON.stringify(bad)} отклонён (400 invalid_duration)`,
      out.status === 400 && out.data?.error === 'invalid_duration', `${out.status} ${JSON.stringify(out.data)}`);
  }
  const dbAfterApiAttempts = await durationInDb();
  check('прямые попытки через API не изменили длительность в базе', dbAfterApiAttempts === 60, `duration_min=${dbAfterApiAttempts}`);
  const omitted = await putDuration(undefined);
  check('поле не передано вовсе - прежний контракт цел, берётся каталожная длительность', omitted.status === 200, `${omitted.status} ${JSON.stringify(omitted.data)}`);
  await db.query('UPDATE master_services SET duration_min = 60 WHERE master_id = $1 AND service_id = $2', [MASTER_ID, service.id]);

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      await s.setViewport(1280, 2400, false);
      await s.navigate(`${siteUrl}/crm-owner.html`);
      // Форму логина рисует crm-auth.js, а не HTML - ждём появления поля циклом
      for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await s.sleep(150);
      await s.eval(`(function(){
        document.getElementById('loginEmail').value = ${JSON.stringify(OWNER_EMAIL)};
        document.getElementById('loginPin').value = ${JSON.stringify(ownerPin)};
        document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
      })()`);
      await s.sleep(1500);

      // Вкладка «Команда» и карточка нашего мастера
      await s.eval(`document.querySelector('label[for="pt-b"]')?.click()`);
      const pickerSel = `.service-picker[data-master-id="${MASTER_ID}"]`;
      let ready = false;
      for (let i = 0; i < 40; i++) {
        ready = JSON.parse(await s.eval(`!!document.querySelector('${pickerSel} .service-check[data-service-id]')`));
        if (ready) break;
        await s.sleep(250);
      }
      check('карточка сотрудника с редактором услуг отрисована', ready);
      await s.eval(`document.querySelector('${pickerSel}')?.closest('details')?.setAttribute('open','')`);

      const setDuration = async (value) => s.eval(`(function(){
        const row = document.querySelector('${pickerSel} .service-check[data-service-id="${service.id}"]');
        const input = row.querySelector('.sc-duration-input');
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event('input', {bubbles:true}));
        input.dispatchEvent(new Event('change', {bubbles:true}));
        return input.value;
      })()`);
      const cardState = async () => JSON.parse(await s.eval(`JSON.stringify((function(){
        const card = document.querySelector('${pickerSel}').closest('.team-editor-card');
        const input = card.querySelector('.sc-duration-input');
        return {
          note: card.querySelector('[data-card-note]')?.textContent ?? '',
          saveDisabled: card.querySelector('[data-save]').disabled,
          invalid: input.classList.contains('is-invalid'),
          ariaInvalid: input.getAttribute('aria-invalid'),
        };
      })())`));

      const clickSave = () => s.eval(`document.querySelector('${pickerSel}').closest('.team-editor-card').querySelector('[data-save]').click()`);
      // Успешное сохранение заканчивается renderTeam() - карточка перерисовывается и
      // строка статуса обнуляется через доли секунды (давнее поведение, к этому фиксу
      // отношения не имеет). Опросом такое окно ловится ненадёжно, поэтому пишем все
      // тексты статуса наблюдателем, поставленным ДО клика
      const recordNotes = () => s.eval(`(function(){
        window.__noteLog = [];
        const host = document.querySelector('${pickerSel}').closest('.team-editor-card').parentElement;
        const read = () => document.querySelectorAll('[data-card-note]').forEach((n) => {
          const t = n.textContent.trim();
          if (t && window.__noteLog[window.__noteLog.length - 1] !== t) window.__noteLog.push(t);
        });
        new MutationObserver(read).observe(host, { childList: true, subtree: true, characterData: true });
        read();
      })()`);
      const notesSeen = async () => JSON.parse(await s.eval('JSON.stringify(window.__noteLog || [])'));
      const ERROR_TEXT = 'Длительность услуги должна быть больше 0 минут';

      // ── сценарий Влада: 0 минут ─────────────────────────────────────────
      await setDuration('0');
      await s.sleep(150);
      const afterZeroInput = await cardState();
      check('кнопка «Сохранить изменения» активна - ноль признан правкой', afterZeroInput.saveDisabled === false, `saveDisabled=${afterZeroInput.saveDisabled}`);

      await clickSave();
      await s.sleep(900);
      const afterZeroSave = await cardState();
      console.log('состояние карточки после попытки сохранить 0 минут:', afterZeroSave);
      check('в карточке показана ошибка про длительность', afterZeroSave.note === ERROR_TEXT, `в строке статуса: "${afterZeroSave.note}"`);
      check('слова «Сохранено» нет', !/Сохранено/.test(afterZeroSave.note), afterZeroSave.note);
      check('поле длительности подсвечено', afterZeroSave.invalid === true);
      check('поле помечено aria-invalid для скринридера', afterZeroSave.ariaInvalid === 'true', String(afterZeroSave.ariaInvalid));
      // SCREENSHOT_DIR=<папка> - снять картинку этого момента для отчёта, по умолчанию не снимаем
      if (process.env.SCREENSHOT_DIR) {
        await s.eval(`document.querySelector('${pickerSel}').scrollIntoView({block:'center'})`);
        await s.sleep(200);
        await s.screenshot(`${process.env.SCREENSHOT_DIR}/dlitelnost-nol-oshibka.png`);
        console.log(`скриншот момента ошибки: ${process.env.SCREENSHOT_DIR}/dlitelnost-nol-oshibka.png`);
      }
      const dbAfterZero = await durationInDb();
      check('в базе осталась прежняя длительность, тихой подмены на 60 не было', dbAfterZero === 60, `duration_min=${dbAfterZero}`);

      // ── пустое поле - тот же класс ввода ────────────────────────────────
      await setDuration('');
      await clickSave();
      await s.sleep(900);
      const afterEmpty = await cardState();
      check('пустое поле тоже блокирует сохранение', afterEmpty.note === ERROR_TEXT, `в строке статуса: "${afterEmpty.note}"`);
      const dbAfterEmpty = await durationInDb();
      check('после пустого поля в базе по-прежнему 60', dbAfterEmpty === 60, `duration_min=${dbAfterEmpty}`);

      // ── контроль: корректная цифра сохраняется как раньше ───────────────
      await setDuration('45');
      await s.sleep(150);
      const afterFix = await cardState();
      check('подсветка снимается сразу после исправления цифры', afterFix.invalid === false);
      await recordNotes();
      await clickSave();
      await s.sleep(2000);
      const notes = await notesSeen();
      console.log('строки статуса, показанные карточкой при сохранении 45 минут:', notes);
      check('корректная длительность сохраняется и карточка это подтверждает', notes.some((t) => /Сохранено/.test(t)), `видели только: ${JSON.stringify(notes)}`);
      const dbAfterValid = await durationInDb();
      check('в базе реально 45 минут', dbAfterValid === 45, `duration_min=${dbAfterValid}`);
    });
  });
});
} catch (e) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', e);
}
summary();
if (crashed) process.exitCode = 1;
