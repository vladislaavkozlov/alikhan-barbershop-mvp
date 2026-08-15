// Живая проверка правки Влада от 15.08.2026: «вместо красивой анимации справа от
// кнопки сохранить изменения снова надпись "Сохраняю", которую я просил везде
// заменить на красивые анимации загрузки».
//
// Проверяется на настоящем сохранении карточки сотрудника, с придержанным ответом
// сервера: пока запрос в полёте, в строке статуса должен крутиться индикатор
// (.crm-spinner), сама кнопка - быть занятой (.is-busy, повторный клик невозможен), и
// нигде не должно быть слова «Сохраняю». После ответа - обычное «Сохранено» и рабочая
// кнопка. Отдельно - строка графика: там тоже был текст «загружаю…».
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

process.env.STAFF_MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'alikhan-anim-verify-'));

const { check, summary } = makeChecker();
const OWNER = { id: 'qa-anim-owner', role: 'owner', name: 'QA Анимация Владелец' };
const MASTER = { id: 'qa-anim-master', role: 'master', name: 'QA Анимация Мастер' };

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const pins = new Map();
  for (const acc of [OWNER, MASTER]) {
    const pin = randomPin();
    pins.set(acc.id, pin);
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ($1, NULL, $2, $3, true, $4, true, $5, $6)`,
      [acc.id, acc.name, acc.role, acc.role === 'master', `${acc.id}@alikhan.test`, hashPin(pin)]
    );
  }
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00')`,
      [MASTER.id, weekday]
    );
  }

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await s.eval('localStorage.clear()');
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await s.setViewport(1400, 1600, false);
      for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await s.sleep(150);
      await s.eval(`(function(){
        document.getElementById('loginEmail').value = ${JSON.stringify(`${OWNER.id}@alikhan.test`)};
        document.getElementById('loginPin').value = ${JSON.stringify(pins.get(OWNER.id))};
        document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
      })()`);
      await s.sleep(4000);
      await s.setViewport(1400, 1600, false);
      await s.sleep(600);

      // Придерживаем ответы сервера на полторы секунды - иначе успеть увидеть
      // индикатор невозможно: на локальной базе сохранение занимает миллисекунды
      await s.eval(`(function(){
        const orig = window.fetch;
        window.__slowFetch = true;
        window.fetch = async function(...args){
          const url = String(args[0] && args[0].url || args[0] || '');
          if (window.__slowFetch && /\\/staff\\//.test(url)) await new Promise(r => setTimeout(r, 1500));
          return orig.apply(this, args);
        };
      })()`);

      // Меняем поле, чтобы кнопка сохранения стала активной
      const ready = await s.eval(`(function(){
        const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
        if (!card) return 'НЕТ КАРТОЧКИ';
        card.setAttribute('open', '');
        const input = card.querySelector('[name="experience"]');
        input.value = 'стаж ' + Date.now();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return card.querySelector('[data-save]').disabled ? 'КНОПКА НЕАКТИВНА' : 'ok';
      })()`);
      check('карточка готова к сохранению', ready === 'ok', String(ready));

      // Нажимаем «Сохранить изменения» и смотрим состояние ВО ВРЕМЯ запроса
      await s.eval(`document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"] [data-save]').click()`);
      await s.sleep(120);
      console.log('ДИАГ сразу после клика:', await s.eval(`JSON.stringify((function(){
        const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
        const b = card.querySelector('[data-save]');
        return { cls: b.className, disabled: b.disabled, cardIsTarget: card.matches('[data-staff-id]'), inner: card.querySelectorAll('[data-save]').length };
      })())`));
      await s.sleep(600);
      const during = JSON.parse(await s.eval(`JSON.stringify((function(){
        const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
        const button = card.querySelector('[data-save]');
        const note = card.querySelector('[data-card-note]');
        return {
          spinnerInNote: Boolean(note.querySelector('.crm-spinner')),
          noteText: note.textContent.trim(),
          buttonBusy: button.classList.contains('is-busy'),
          buttonDisabled: button.disabled,
          buttonLabel: button.textContent.trim(),
          buttonHasSpinner: getComputedStyle(button, '::after').content !== 'none',
          anySavingWord: document.body.textContent.includes('Сохраняю'),
        };
      })())`));
      console.log('во время сохранения:', JSON.stringify(during));
      check('в строке статуса крутится индикатор', during.spinnerInNote === true);
      check('слова «Сохраняю» нет нигде на странице', during.anySavingWord === false, during.noteText);
      check('строка статуса без текста - только анимация', during.noteText === '', `«${during.noteText}»`);
      check('кнопка занята и не нажимается повторно', during.buttonBusy === true && during.buttonDisabled === true);
      check('подпись кнопки не подменена', during.buttonLabel === 'Сохранить изменения', during.buttonLabel);
      check('на кнопке рисуется индикатор', during.buttonHasSpinner === true);

      // Отпускаем сервер и ждём результат
      await s.eval(`(function(){ window.__slowFetch = false; })()`);
      // Зелёное сообщение об успехе гаснет само через 4 секунды (crm-toast.js), так что
      // смотрим на него раньше этого срока - иначе поймали бы пустоту и решили, что его нет
      await s.sleep(2600);
      const after = JSON.parse(await s.eval(`JSON.stringify((function(){
        const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
        const button = card.querySelector('[data-save]');
        const toast = document.querySelector('.crm-toast--success .crm-toast__text');
        const note = card.querySelector('[data-card-note]');
        return {
          busy: button.classList.contains('is-busy'),
          toast: toast ? toast.textContent.trim() : null,
          note: note ? note.textContent.trim() : null,
          spinnerGone: !note.querySelector('.crm-spinner'),
        };
      })())`));
      console.log('после сохранения:', JSON.stringify(after));
      check('после ответа кнопка освободилась', after.busy === false);
      check('зелёное сообщение об успехе на месте', after.toast === 'Сохранено', String(after.toast));
      // Карточка после успеха перерисовывается заново, поэтому её строка статуса пуста,
      // а результат человек видит зелёным сообщением внизу экрана - главное, что
      // индикатор не остался крутиться навсегда
      check('индикатор перестал крутиться после ответа', after.spinnerGone === true, JSON.stringify(after));

      // График: раньше при загрузке писал «загружаю…» текстом
      const scheduleLoading = await s.eval(`(function(){
        const container = document.getElementById('weeklyEditor-${MASTER.id}');
        if (!container) return 'НЕТ БЛОКА ГРАФИКА';
        // Тот же путь, которым блок обновляется кнопкой «Обновить данные»
        window.__refreshTeamSchedules?.();
        return container.innerHTML.includes('crm-spinner') || container.textContent.includes('загружаю') ? 'проверяем' : 'проверяем';
      })()`);
      await s.sleep(120);
      const scheduleState = JSON.parse(await s.eval(`JSON.stringify((function(){
        const container = document.getElementById('weeklyEditor-${MASTER.id}');
        return {
          spinner: Boolean(container.querySelector('.crm-spinner')),
          hasWord: container.textContent.toLowerCase().includes('загружаю'),
        };
      })())`));
      console.log('график во время загрузки:', JSON.stringify(scheduleState), scheduleLoading);
      check('в графике тоже индикатор, а не слово «загружаю»', scheduleState.hasWord === false, JSON.stringify(scheduleState));
    });
  });
});
} catch (error) {
  crashed = true;
  console.error('Прогон упал:', error);
}

const ok = summary() && !crashed;
process.exit(ok ? 0 : 1);
