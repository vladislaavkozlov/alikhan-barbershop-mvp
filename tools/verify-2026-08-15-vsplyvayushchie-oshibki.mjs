// Живая проверка правки Влада от 15.08.2026: сообщения об ошибке должны всплывать
// внизу экрана отдельным окном (как плавающая кнопка «Свернуть все»), с кнопкой
// закрытия, у ВСЕХ четырёх ролей - владелец, управляющий, администратор, мастер.
// Раньше текст жил только в строке статуса внизу длинной карточки: поле краснело, а
// за причиной надо было листать.
//
// Проверяется на реальных ошибках, а не на подменённом fetch: владелец и управляющий
// - нулевая длительность услуги и занятый email (код сервера email_in_use),
// администратор - продажа без названия, мастер - заявка без даты.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();

const ACCOUNTS = [
  { id: 'qa-toast-owner', role: 'owner', name: 'QA Тосты Владелец', page: 'crm-owner.html' },
  { id: 'qa-toast-manager', role: 'manager', name: 'QA Тосты Управляющий', page: 'crm-owner.html' },
  { id: 'qa-toast-admin', role: 'admin', name: 'QA Тосты Администратор', page: 'crm-admin.html' },
  { id: 'qa-toast-master', role: 'master', name: 'QA Тосты Мастер', page: 'crm-master.html' },
];

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const pins = new Map();
  for (const acc of ACCOUNTS) {
    const pin = randomPin();
    pins.set(acc.id, pin);
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ($1, NULL, $2, $3, true, $4, true, $5, $6)`,
      [acc.id, `${acc.name} (verify, эфемерная база)`, acc.role, acc.role === 'master', `${acc.id}@alikhan.test`, hashPin(pin)]
    );
  }
  // Услуга мастеру - на ней владелец и управляющий получат ошибку длительности
  const service = (await db.query('SELECT id, name FROM services ORDER BY id LIMIT 1')).rows[0];
  await db.query('INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, 1000, 60)',
    ['qa-toast-master', service.id]);
  // Рабочая неделя мастеру обязательна именно для управляющего: filterStaffForViewer
  // (api/lib/schedule-core.js) отдаёт всех подряд только владельцу и администратору, а
  // роли manager - лишь мастеров с хотя бы одним рабочим днём. Без этой фикстуры
  // карточки мастера в команде управляющего просто нет, и проверять окно ошибки не на чем
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00')`,
      ['qa-toast-master', weekday]
    );
  }
  console.log(`фикстуры: 4 роли, услуга "${service.name}" у мастера, рабочая неделя 10:00-20:00`);

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      const login = async (acc) => {
        await s.navigate(`${siteUrl}/${acc.page}`);
        await s.eval('localStorage.clear()');
        await s.navigate(`${siteUrl}/${acc.page}`);
        await s.setViewport(1280, 1400, false);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await s.sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = ${JSON.stringify(`${acc.id}@alikhan.test`)};
          document.getElementById('loginPin').value = ${JSON.stringify(pins.get(acc.id))};
          document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
        })()`);
        await s.sleep(1800);
        // Реальная навигация после логина сбрасывает device metrics - ставим заново
        await s.setViewport(1280, 1400, false);
        await s.sleep(400);
      };

      const toastState = async () => JSON.parse(await s.eval(`JSON.stringify((function(){
        const toast = document.querySelector('.crm-toast');
        if (!toast) return { present: false };
        const rect = toast.getBoundingClientRect();
        const host = document.querySelector('.crm-toasts');
        const floatBtn = document.querySelector('.panel-group-controls');
        const btnRect = floatBtn ? floatBtn.getBoundingClientRect() : null;
        const overlapsButton = btnRect ? !(rect.right < btnRect.left || rect.left > btnRect.right || rect.bottom < btnRect.top || rect.top > btnRect.bottom) : false;
        return {
          present: true,
          text: toast.querySelector('.crm-toast__text').textContent,
          hasClose: !!toast.querySelector('.crm-toast__close'),
          fixed: getComputedStyle(host).position === 'fixed',
          nearBottom: (innerHeight - rect.bottom) < 140,
          onScreen: rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          count: document.querySelectorAll('.crm-toast').length,
          overlapsButton,
          overlapsSidebar: (function(){
            const bar = document.querySelector('.app-sidebar');
            if (!bar || getComputedStyle(bar).display === 'none') return false;
            const b = bar.getBoundingClientRect();
            return rect.left < b.right - 1;
          })(),
        };
      })())`));

      const clearToasts = () => s.eval(`document.querySelectorAll('.crm-toast').forEach(t => t.remove())`);

      // ─── Владелец и управляющий: карточка команды ────────────────────────
      for (const acc of ACCOUNTS.filter((a) => a.role === 'owner' || a.role === 'manager')) {
        await login(acc);
        await s.eval(`document.querySelector('label[for="pt-b"]')?.click()`);
        const pickerSel = '.service-picker[data-master-id="qa-toast-master"]';
        let ready = false;
        for (let i = 0; i < 40; i++) {
          ready = JSON.parse(await s.eval(`!!document.querySelector('${pickerSel} .service-check[data-service-id]')`));
          if (ready) break;
          await s.sleep(250);
        }
        check(`${acc.role}: карточка сотрудника открылась`, ready);
        await s.eval(`document.querySelector('${pickerSel}')?.closest('details')?.setAttribute('open','')`);
        await s.eval(`(function(){
          const input = document.querySelector('${pickerSel} .service-check[data-service-id="${service.id}"] .sc-duration-input');
          input.value = '0';
          input.dispatchEvent(new Event('input', {bubbles:true}));
          input.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        await s.sleep(200);
        await s.eval(`document.querySelector('${pickerSel}').closest('.team-editor-card').querySelector('[data-save]').click()`);
        await s.sleep(800);
        const state = await toastState();
        console.log(`${acc.role}:`, state);
        check(`${acc.role}: сообщение всплыло отдельным окном`, state.present);
        check(`${acc.role}: текст объясняет причину`, state.text === 'Длительность услуги должна быть больше 0 минут', state.text);
        check(`${acc.role}: у окна есть кнопка закрытия`, state.hasClose === true);
        check(`${acc.role}: окно закреплено на экране, не в потоке страницы`, state.fixed === true);
        check(`${acc.role}: окно внизу экрана`, state.nearBottom === true);
        check(`${acc.role}: окно целиком помещается в экран`, state.onScreen === true);
        check(`${acc.role}: окно не перекрывает кнопку «Свернуть все»`, state.overlapsButton === false);
        check(`${acc.role}: окно стоит правее бокового меню, а не поверх него`, state.overlapsSidebar === false);

        // Ошибка ждёт человека, а не гаснет сама
        await s.sleep(6000);
        const still = await toastState();
        check(`${acc.role}: ошибка не исчезает сама через 6 секунд`, still.present === true);

        // Повтор того же действия не плодит копии
        await s.eval(`document.querySelector('${pickerSel}').closest('.team-editor-card').querySelector('[data-save]').click()`);
        await s.sleep(600);
        const repeated = await toastState();
        check(`${acc.role}: повтор той же ошибки не плодит окна`, repeated.count === 1, `окон: ${repeated.count}`);

        // Крестик закрывает
        await s.eval(`document.querySelector('.crm-toast__close').click()`);
        await s.sleep(200);
        const closed = await toastState();
        check(`${acc.role}: кнопка закрытия убирает окно`, closed.present === false);
      }

      // ─── Владелец: код ошибки от сервера человеческим языком ─────────────
      await login(ACCOUNTS[0]);
      await s.eval(`document.querySelector('label[for="pt-b"]')?.click()`);
      for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.querySelector(".team-add-card [data-create]")')); i++) await s.sleep(250);
      await clearToasts();
      await s.eval(`(function(){
        const card = document.querySelector('.team-add-card');
        card.setAttribute('open','');
        card.querySelector('[name="name"]').value = 'Тёзка по почте';
        card.querySelector('[name="email"]').value = 'qa-toast-admin@alikhan.test';
        card.querySelector('[data-create]').click();
      })()`);
      await s.sleep(1500);
      const emailState = await toastState();
      console.log('owner, занятый email:', emailState);
      check('код сервера email_in_use показан человеческой фразой',
        emailState.text === 'Не удалось создать сотрудника: Этот email уже занят другим сотрудником', emailState.text);
      check('в тексте нет машинного кода и HTTP-статуса', !/[a-z_]{6,}|\d{3}/.test(emailState.text ?? ''), emailState.text);

      // ─── Администратор: продажа без названия ─────────────────────────────
      await login(ACCOUNTS[2]);
      let saleReady = false;
      for (let i = 0; i < 40; i++) {
        saleReady = JSON.parse(await s.eval('!!document.getElementById("wfSaleSubmit")'));
        if (saleReady) break;
        await s.sleep(250);
      }
      if (saleReady) {
        await clearToasts();
        await s.eval('document.getElementById("wfSaleSubmit").click()');
        await s.sleep(700);
        const adminState = await toastState();
        console.log('admin:', adminState);
        check('администратор: ошибка всплывает тем же окном', adminState.present === true);
        check('администратор: текст объясняет, что не так', /Укажите название товара/.test(adminState.text ?? ''), adminState.text);
        check('администратор: окно закреплено внизу экрана', adminState.fixed === true && adminState.nearBottom === true);
      } else {
        check('администратор: форма продажи найдена на странице', false, 'кнопка saleSubmit не найдена - сценарий не проверен');
      }

      // ─── Мастер: заявка без даты ─────────────────────────────────────────
      await login(ACCOUNTS[3]);
      let formReady = false;
      for (let i = 0; i < 40; i++) {
        formReady = JSON.parse(await s.eval('!!document.getElementById("reqSubmitBtn")'));
        if (formReady) break;
        await s.sleep(250);
      }
      if (formReady) {
        await clearToasts();
        // Дата в форме предзаполнена сегодняшним днём - пустой её делает сам мастер,
        // очистив виджет; воспроизводим именно это состояние, иначе клик просто
        // отправит корректную заявку и проверять будет нечего
        await s.eval(`document.getElementById('reqDateFrom').dataset.value = ''`);
        await s.eval('document.getElementById("reqSubmitBtn").click()');
        await s.sleep(700);
        const masterState = await toastState();
        console.log('master:', masterState);
        check('мастер: ошибка всплывает тем же окном', masterState.present === true);
        check('мастер: текст объясняет, что не так', /Укажите дату/.test(masterState.text ?? ''), masterState.text);
        check('мастер: у окна есть кнопка закрытия', masterState.hasClose === true);
        check('мастер: окно закреплено внизу экрана', masterState.fixed === true && masterState.nearBottom === true);

        // Успех показывается тем же окном и гаснет сам - листать за подтверждением
        // тоже не нужно
        await s.eval(`document.querySelector('.crm-toast__close')?.click()`);
        // Возвращаем дату - теперь заявка уходит по-настоящему
        await s.eval(`(function(){
          const d = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
          document.getElementById('reqDateFrom').dataset.value = d;
          document.getElementById('reqDateTo').dataset.value = d;
        })()`);
        await s.eval(`document.getElementById('reqSubmitBtn').click()`);
        await s.sleep(1200);
        const okState = await toastState();
        console.log('master, успешная заявка:', okState);
        check('мастер: успех подтверждается тем же окном', /Запрос отправлен/.test(okState.text ?? ''), okState.text);
        await s.sleep(4200);
        const okGone = await toastState();
        check('мастер: подтверждение гаснет само, ошибка - нет', okGone.present === false);
      } else {
        check('мастер: форма заявки найдена на странице', false, 'кнопка reqSubmitBtn не найдена - сценарий не проверен');
      }

      // ─── Узкий экран: окно не уезжает за край и не садится на кнопку ─────
      await s.setViewport(390, 844, true);
      await s.sleep(400);
      await s.eval(`document.getElementById('reqDateFrom').dataset.value = ''`);
      await s.eval(`document.getElementById('reqSubmitBtn')?.click()`);
      await s.sleep(700);
      const mobileState = await toastState();
      console.log('мобильный экран:', mobileState);
      check('мобильный экран: окно целиком в пределах экрана', mobileState.present === true && mobileState.onScreen === true);
      check('мобильный экран: окно не перекрывает плавающую кнопку', mobileState.overlapsButton === false);

      if (process.env.SCREENSHOT_DIR) {
        await s.setViewport(1280, 1400, false);
        await s.sleep(300);
        await s.eval(`document.getElementById('reqDateFrom').dataset.value = ''`);
        await s.eval(`document.getElementById('reqSubmitBtn')?.click()`);
        await s.sleep(600);
        await s.screenshot(`${process.env.SCREENSHOT_DIR}/toast-master.png`);
        console.log(`скриншот: ${process.env.SCREENSHOT_DIR}/toast-master.png`);
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
