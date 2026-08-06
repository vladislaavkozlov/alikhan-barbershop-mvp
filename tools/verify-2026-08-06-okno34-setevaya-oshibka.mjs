// Живая проверка Окна 34 - клиент не теряет запись при сетевой ошибке.
//
// Единственное необработанное исключение во всём app.js (PRODUCT_AUDIT_REPORT.md,
// раздел «Клиент»): если сеть/бэкенд недоступны в момент POST /bookings, кнопка
// "Подтвердить запись" оставалась disabled навсегда без сообщения об ошибке.
// Аналогично для refreshSlots() - слоты не обновлялись молча.
//
// Своя эфемерная база/сервер (tools/verify-lib.mjs) - не завязано на чужие фикстуры.
// Сетевая ошибка симулируется подменой window.fetch на reject ПОСЛЕ того, как
// страница и мастер/услуги/слоты уже нормально загружены штатным fetch - это точно
// воспроизводит "сеть отвалилась в момент клика", а не "сеть не работала с самого начала".
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, daysFromToday } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOKING_DATE = daysFromToday(20);

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  // master-1: обычный рабочий график каждый день, чтобы дата была бронируемой.
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT 'master-1', d, true, '10:00', '20:00' FROM generate_series(1,7) d`
  );

  await withStaticServer(apiUrl, async (base) => {
    await withBrowser(async (s) => {
      await s.navigate(`${base}/index.html`);
      await s.setViewport(390, 900, true);
      await sleep(400);

      // master-1 = первая карточка мастера.
      await s.click('#master-grid .option-card');
      await sleep(300); // GET /master-services

      await s.eval(`(function(){
        const btn = document.querySelector('#service-grid .option-card');
        if (btn) btn.click();
      })()`);
      await sleep(150);

      // Выбираем дату через date-picker (обходим предустановленный "сегодня").
      await s.click('#date-toggle');
      await sleep(150);
      const pickedDate = await s.eval(`(function(){
        const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
        const target = btns.find((b) => b.dataset.iso === '${BOOKING_DATE}');
        if (!target || target.disabled) return false;
        target.click();
        return true;
      })()`);
      check('целевая дата найдена в календаре и кликабельна', pickedDate === true);
      await sleep(500); // refreshSlots штатным fetch

      const slotsBefore = await s.eval(`Array.from(document.querySelectorAll('#slots-wrap .slot-btn')).map((b) => b.textContent)`);
      check('штатная загрузка слотов вернула непустой список (до симуляции обрыва)', Array.isArray(slotsBefore) && slotsBefore.length > 0);

      // ── Сценарий 2: refreshSlots() при сетевой ошибке - не тишина ─────────
      await s.eval(`window.__origFetch = window.fetch; window.fetch = () => Promise.reject(new TypeError('Failed to fetch (симуляция обрыва)'));`);
      // Переключаем дату ещё раз - триггерим повторный refreshSlots() поверх мёртвой сети.
      await s.click('#date-toggle');
      await sleep(150);
      const nextDate = await s.eval(`(function(){
        const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
        const target = btns.find((b) => b.dataset.iso !== '${BOOKING_DATE}' && !b.disabled);
        if (!target) return null;
        target.click();
        return target.dataset.iso;
      })()`);
      check('вторая дата для триггера refreshSlots() найдена', typeof nextDate === 'string');
      await sleep(500);

      const slotButtonsAfterError = await s.eval(`document.querySelectorAll('#slots-wrap .slot-btn').length`);
      // Важно: не просто "slots-wrap непустой" (старый рендер из ПРЕДЫДУЩЕЙ успешной
      // даты остаётся в DOM, если исключение вылетело ДО slotsWrap.replaceChildren() -
      // это застрявший старый список, не сообщение об ошибке, ложный зелёный).
      // Проверяем именно свежий .slots-hint с текстом - его создаёт только resetSlots().
      const hintTextAfterError = await s.eval(`document.querySelector('#slots-wrap .slots-hint')?.textContent || null`);
      check(
        'refreshSlots(): при сетевой ошибке слоты НЕ рисуются молча (нет .slot-btn, старый список очищен)',
        slotButtonsAfterError === 0
      );
      check(
        'refreshSlots(): при сетевой ошибке показан именно .slots-hint с текстом (не застрявший старый рендер)',
        typeof hintTextAfterError === 'string' && hintTextAfterError.trim().length > 0
      );

      // ── Сценарий 1: POST /bookings при сетевой ошибке - кнопка не виснет ──
      // Возвращаем дату с реальными слотами, восстанавливаем живой fetch, выбираем
      // слот+согласие+данные клиента как обычный happy path, и уже ПОСЛЕ этого рвём
      // сеть - ровно "сеть отвалилась в момент нажатия Подтвердить".
      await s.eval(`window.fetch = window.__origFetch;`);
      await s.click('#date-toggle');
      await sleep(150);
      await s.eval(`(function(){
        const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
        const target = btns.find((b) => b.dataset.iso === '${BOOKING_DATE}');
        if (target) target.click();
      })()`);
      await sleep(500);

      await s.click('#slots-wrap .slot-btn');
      await sleep(100);
      await s.type('#f-name', 'Тест Окно34');
      await s.type('#f-phone', '+79991234567');
      await s.eval(`(function(){
        const cb = document.getElementById('f-consent');
        if (cb && !cb.checked) cb.click();
      })()`);
      await sleep(100);

      const submitEnabledBeforeBreak = await s.eval(`!document.getElementById('f-submit').disabled`);
      check('кнопка "Подтвердить запись" разблокирована перед симуляцией обрыва (форма заполнена штатно)', submitEnabledBeforeBreak === true);

      // Рвём сеть ровно перед нажатием кнопки.
      await s.eval(`window.__origFetch2 = window.fetch; window.fetch = () => Promise.reject(new TypeError('Failed to fetch (симуляция обрыва при отправке)'));`);
      await s.click('#f-submit');
      await sleep(400);

      const submitDisabledAfterFail = await s.eval(`document.getElementById('f-submit').disabled`);
      const errMsgAfterFail = await s.eval(`document.getElementById('form-msg').textContent`);
      const errMsgClassAfterFail = await s.eval(`document.getElementById('form-msg').className`);
      check(
        'POST /bookings: после сетевой ошибки кнопка РАЗБЛОКИРОВАНА (не виснет навсегда)',
        submitDisabledAfterFail === false
      );
      check(
        'POST /bookings: после сетевой ошибки показано сообщение об ошибке',
        typeof errMsgAfterFail === 'string' && errMsgAfterFail.trim().length > 0 && errMsgClassAfterFail.includes('error')
      );
      await s.eval(`document.getElementById('form-msg').scrollIntoView({block:'center',behavior:'instant'})`);
      await sleep(100);
      await s.screenshot('/tmp/okno34-network-error-state.png');

      // Повтор тем же нажатием без перезагрузки страницы - восстанавливаем сеть и
      // жмём кнопку ещё раз, ничего больше не трогая (тот же выбранный слот/данные).
      await s.eval(`window.fetch = window.__origFetch2;`);
      await s.click('#f-submit');
      await sleep(500);

      const receiptTitle = await s.eval(`document.querySelector('.receipt-title')?.textContent || null`);
      check(
        'повторное нажатие БЕЗ перезагрузки страницы после восстановления сети - запись проходит успешно',
        receiptTitle === 'Готово! Запись подтверждена'
      );
      await s.eval(`document.getElementById('form-msg').scrollIntoView({block:'center',behavior:'instant'})`);
      await sleep(100);
      await s.screenshot('/tmp/okno34-recovered-success-state.png');

      // ── Регрессия: обычная успешная запись отдельным чистым прогоном ──────
      await s.navigate(`${base}/index.html`);
      await s.setViewport(390, 900, true);
      await sleep(400);
      await s.click('#master-grid .option-card');
      await sleep(300);
      await s.eval(`(function(){ const b = document.querySelector('#service-grid .option-card'); if (b) b.click(); })()`);
      await sleep(150);
      await s.click('#date-toggle');
      await sleep(150);
      await s.eval(`(function(){
        const btns = Array.from(document.querySelectorAll('#cal-grid .cal-day'));
        const target = btns.find((b) => b.dataset.iso === '${BOOKING_DATE}');
        if (target) target.click();
      })()`);
      await sleep(500);
      const slotsRegression = await s.eval(`document.querySelectorAll('#slots-wrap .slot-btn').length`);
      if (slotsRegression > 0) {
        await s.click('#slots-wrap .slot-btn');
        await s.type('#f-name', 'Регрессия Окно34');
        await s.type('#f-phone', '+79997654321');
        await s.eval(`(function(){ const cb = document.getElementById('f-consent'); if (cb && !cb.checked) cb.click(); })()`);
        await sleep(100);
        await s.click('#f-submit');
        await sleep(500);
        const regressionReceipt = await s.eval(`document.querySelector('.receipt-title')?.textContent || null`);
        check('регрессия: обычная успешная запись без симуляции ошибок работает как раньше (число шагов не изменилось)', regressionReceipt === 'Готово! Запись подтверждена');
        const regressionMsgClass = await s.eval(`document.getElementById('form-msg').className`);
        check('регрессия: сообщение об ошибке НЕ появляется, если ошибки не было', !regressionMsgClass.includes('error'));
      } else {
        check('регрессия: слоты для чистого прогона нашлись', false);
      }

      await s.screenshot('/tmp/okno34-final-state.png');
    });
  });
});
} catch (err) {
  crashed = true;
  console.error('Прогон упал с ошибкой:', err);
}
process.exit(summary() && !crashed ? 0 : 1);
