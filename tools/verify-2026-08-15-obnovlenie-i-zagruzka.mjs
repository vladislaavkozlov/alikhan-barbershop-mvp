// Живая проверка двух правок Влада от 15.08.2026:
// 1) кнопка обновления в шапке возвращает несохранённые правки к сохранённым
//    значениям (его пример: длительность услуги поменяли с 40 на 20, не сохранили,
//    нажали «Обновить» - должно снова стать 40, а оставалось 20);
// 2) состояния загрузки анимированы - экран первичной загрузки кабинета и
//    полосы-заготовки вместо голой надписи «Загружаю…».
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const OWNER_EMAIL = 'qa-refresh-owner@alikhan.test';
const MASTER_ID = 'qa-refresh-master';
const SAVED_DURATION = 40;

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const ownerPin = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('qa-refresh-owner', NULL, 'QA Обновление Владелец (verify)', 'owner', true, false, true, $1, $2),
     ($3, NULL, 'QA Обновление Мастер (verify)', 'master', true, true, true, 'qa-refresh-master@alikhan.test', $4)`,
    [OWNER_EMAIL, hashPin(ownerPin), MASTER_ID, hashPin(randomPin())]
  );
  const service = (await db.query('SELECT id, name FROM services ORDER BY id LIMIT 1')).rows[0];
  await db.query('INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, 1000, $3)',
    [MASTER_ID, service.id, SAVED_DURATION]);
  console.log(`фикстура: услуга "${service.name}" у мастера, сохранённая длительность ${SAVED_DURATION} мин`);

  const durationInDb = async () =>
    (await db.query('SELECT duration_min FROM master_services WHERE master_id = $1 AND service_id = $2', [MASTER_ID, service.id]))
      .rows[0]?.duration_min ?? null;

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await s.setViewport(1280, 1400, false);
      for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await s.sleep(150);

      // ── Экран первичной загрузки: появляется сразу после входа ────────────
      await s.eval(`(function(){
        window.__loaderSeen = false;
        new MutationObserver(() => {
          if (document.querySelector('.crm-page-loader')) window.__loaderSeen = true;
        }).observe(document.body, { childList: true, subtree: true });
        document.getElementById('loginEmail').value = ${JSON.stringify(OWNER_EMAIL)};
        document.getElementById('loginPin').value = ${JSON.stringify(ownerPin)};
        document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
      })()`);
      await s.sleep(2500);
      await s.setViewport(1280, 1400, false);
      // Владелец заходит на свою же страницу - навигации после логина нет, значит
      // наблюдатель пережил вход и его показания честные
      const loaderSeen = JSON.parse(await s.eval('JSON.stringify(window.__loaderSeen ?? null)'));
      const loaderGone = JSON.parse(await s.eval('!document.querySelector(".crm-page-loader")'));
      check('экран первичной загрузки реально показывался', loaderSeen === true, `наблюдатель: ${loaderSeen}`);
      check('экран первичной загрузки убран, когда данные пришли', loaderGone === true);

      await s.eval(`document.querySelector('label[for="pt-b"]')?.click()`);
      const pickerSel = `.service-picker[data-master-id="${MASTER_ID}"]`;
      let ready = false;
      for (let i = 0; i < 40; i++) {
        ready = JSON.parse(await s.eval(`!!document.querySelector('${pickerSel} .service-check[data-service-id]')`));
        if (ready) break;
        await s.sleep(250);
      }
      check('карточка сотрудника открылась', ready);
      await s.eval(`document.querySelector('${pickerSel}')?.closest('details')?.setAttribute('open','')`);

      const durationOnScreen = async () => JSON.parse(await s.eval(
        `JSON.stringify(document.querySelector('${pickerSel} .service-check[data-service-id="${service.id}"] .sc-duration-input')?.value ?? null)`
      ));
      check('на экране сохранённая длительность', await durationOnScreen() === String(SAVED_DURATION), `на экране ${await durationOnScreen()}`);

      // ── Сценарий Влада: поменяли и не сохранили ──────────────────────────
      await s.eval(`(function(){
        const input = document.querySelector('${pickerSel} .service-check[data-service-id="${service.id}"] .sc-duration-input');
        input.value = '20';
        input.dispatchEvent(new Event('input', {bubbles:true}));
        input.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
      await s.sleep(200);
      check('введённые 20 минут видны на экране до обновления', await durationOnScreen() === '20');
      check('в базе по-прежнему сохранённое значение', await durationInDb() === SAVED_DURATION, `в базе ${await durationInDb()}`);

      // ── Кнопка обновления ────────────────────────────────────────────────
      const spinning = JSON.parse(await s.eval(`(function(){
        const btn = document.getElementById('refreshBtn');
        btn.click();
        return btn.classList.contains('is-refreshing');
      })()`));
      check('кнопка обновления показывает, что идёт работа', spinning === true);
      await s.sleep(2500);

      const afterRefresh = await durationOnScreen();
      console.log(`длительность на экране после обновления: ${afterRefresh}`);
      check('несохранённая правка сброшена к сохранённому значению', afterRefresh === String(SAVED_DURATION), `на экране ${afterRefresh}`);
      check('в базе ничего не поменялось', await durationInDb() === SAVED_DURATION, `в базе ${await durationInDb()}`);

      const notice = JSON.parse(await s.eval(
        `JSON.stringify(document.querySelector('.crm-toast__text')?.textContent ?? null)`
      ));
      console.log('сообщение после обновления:', notice);
      check('человеку объяснили, почему цифра изменилась', /не были сохранены|сброшены/i.test(notice ?? ''), String(notice));

      // Кнопка сохранения снова неактивна - карточка чистая
      const saveDisabled = JSON.parse(await s.eval(
        `JSON.stringify(document.querySelector('${pickerSel}').closest('.team-editor-card').querySelector('[data-save]').disabled)`
      ));
      check('кнопка сохранения снова неактивна - несохранённого не осталось', saveDisabled === true);

      // ── Обновление без правок молчит ─────────────────────────────────────
      await s.eval(`document.querySelectorAll('.crm-toast').forEach(t => t.remove())`);
      await s.eval(`document.getElementById('refreshBtn').click()`);
      await s.sleep(2500);
      const quiet = JSON.parse(await s.eval(`!document.querySelector('.crm-toast')`));
      check('обновление без правок не показывает лишних сообщений', quiet === true);

      // ── Анимация заготовок ───────────────────────────────────────────────
      const skeleton = JSON.parse(await s.eval(`JSON.stringify((function(){
        const host = document.querySelector('.service-picker[data-master-id]');
        host.innerHTML = '<div class="crm-skeleton"><span class="crm-skeleton__row"></span></div>';
        const row = host.querySelector('.crm-skeleton__row');
        const style = getComputedStyle(row);
        return { animation: style.animationName, duration: style.animationDuration, height: row.getBoundingClientRect().height };
      })())`));
      console.log('полоса-заготовка:', skeleton);
      check('полосы-заготовки анимированы, а не статичны', skeleton.animation === 'crm-skeleton-sweep', skeleton.animation);
      check('заготовка занимает место будущего содержимого', skeleton.height > 8, `высота ${skeleton.height}`);

      const spinner = JSON.parse(await s.eval(`JSON.stringify((function(){
        const host = document.querySelector('.service-picker[data-master-id]');
        host.innerHTML = '<span class="crm-loading-line"><span class="crm-spinner"></span>Загружаю…</span>';
        return getComputedStyle(host.querySelector('.crm-spinner')).animationName;
      })())`));
      check('индикатор в строке загрузки крутится', spinner === 'crm-spin', spinner);

      // ── Экран загрузки живьём: замедляем сеть и заходим заново ───────────
      await s.send('Network.emulateNetworkConditions', {
        offline: false, latency: 350, downloadThroughput: 500 * 1024, uploadThroughput: 500 * 1024,
      });
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await s.setViewport(1280, 1400, false);
      let loaderShot = null;
      for (let i = 0; i < 150; i++) {
        const seen = JSON.parse(await s.eval(`JSON.stringify((function(){
          const el = document.querySelector('.crm-page-loader');
          if (!el) return null;
          const spinner = el.querySelector('.crm-spinner');
          return { text: el.querySelector('.crm-page-loader__text')?.textContent ?? '', spin: getComputedStyle(spinner).animationName };
        })())`));
        if (seen) { loaderShot = seen; break; }
        await s.sleep(100);
      }
      console.log('экран загрузки на медленной сети:', loaderShot);
      check('на медленной сети видно экран загрузки с крутящимся индикатором',
        loaderShot?.spin === 'crm-spin', JSON.stringify(loaderShot));
      check('на экране загрузки написано, что происходит', /Готовлю/.test(loaderShot?.text ?? ''), loaderShot?.text);

      // Экран проявляется за 140 мс - замеряем и снимаем уже установившееся состояние,
      // иначе поймаем полупрозрачную середину анимации и решим, что он просвечивает
      await s.sleep(400);
      const settled = JSON.parse(await s.eval(`JSON.stringify((function(){
        const el = document.querySelector('.crm-page-loader');
        if (!el) return null;
        const style = getComputedStyle(el);
        const bar = document.querySelector('.app-sidebar');
        const point = bar && style.display !== 'none' ? bar.getBoundingClientRect() : null;
        const covering = point
          ? document.elementFromPoint(point.left + point.width / 2, point.top + point.height / 2)
          : null;
        return {
          opacity: style.opacity,
          background: style.backgroundColor,
          coversSidebar: point ? (covering === el || el.contains(covering)) : 'меню скрыто',
        };
      })())`));
      console.log('установившийся экран загрузки:', settled);
      if (settled) {
        check('экран загрузки непрозрачен - интерфейс под ним не просвечивает', settled.opacity === '1', `opacity=${settled.opacity}`);
        check('экран загрузки перекрывает и боковое меню', settled.coversSidebar !== false, String(settled.coversSidebar));
      }
      if (process.env.SCREENSHOT_DIR && loaderShot) {
        await s.screenshot(`${process.env.SCREENSHOT_DIR}/zagruzka-ekran.png`);
        console.log(`скриншот экрана загрузки: ${process.env.SCREENSHOT_DIR}/zagruzka-ekran.png`);
      }
      await s.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      });

      if (process.env.SCREENSHOT_DIR) {
        await s.eval(`(function(){
          const host = document.querySelector('.service-picker[data-master-id]');
          host.innerHTML = '<div class="crm-skeleton"><span class="crm-skeleton__row"></span><span class="crm-skeleton__row"></span><span class="crm-skeleton__row"></span><span class="crm-skeleton__row"></span></div>';
          host.closest('details')?.setAttribute('open','');
          host.scrollIntoView({ block: 'center' });
        })()`);
        await s.sleep(400);
        await s.screenshot(`${process.env.SCREENSHOT_DIR}/zagruzka-skeleton.png`);
        console.log(`скриншот заготовок: ${process.env.SCREENSHOT_DIR}/zagruzka-skeleton.png`);
      }
    });
  });
});
} catch (e) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', e);
}
summary();
if (crashed) process.exitCode = 1;
