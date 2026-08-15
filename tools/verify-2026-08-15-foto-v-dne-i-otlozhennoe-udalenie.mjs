// Живая проверка двух правок Влада от 15.08.2026:
//   1. «загруженная фотка не обновилась во вкладке День, и кнопка обновить не дала
//      результата» - состав сотрудников для расписания снимался один раз при входе,
//      поэтому новое фото появлялось в колонках только после перезагрузки страницы.
//   2. «при нажатии на удалить фото нужно, чтобы финальное удаление подтверждалось
//      кнопкой Сохранить изменения, а не удалялось сразу. При нажатии удалить (без
//      сохранения) кнопка обновления должна возвращать фотку обратно».
//
// Всё на эфемерной базе и настоящем сервере, фото - реальный файл, загруженный через
// окно кадрирования (тот же путь, которым пользуется владелец).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

// Боевое хранилище фото - диск Amvera, локально его нет
process.env.STAFF_MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'alikhan-media-verify-'));

const { check, summary } = makeChecker();
const OWNER = { id: 'qa-foto-owner', role: 'owner', name: 'QA Фото Владелец' };
const MASTER = { id: 'qa-foto-master', role: 'master', name: 'QA Фото Мастер' };

// Выбираем фото и проходим окно кадрирования до конца
const PICK_AND_SAVE = `(async function(){
  const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
  if (!card) return 'НЕТ КАРТОЧКИ';
  card.setAttribute('open', '');
  const canvas = document.createElement('canvas');
  canvas.width = 600; canvas.height = 600;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d02020'; ctx.fillRect(0, 0, 600, 600);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'proba.png', { type: 'image/png' }));
  const input = card.querySelector('input[name="avatar"]');
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1500));
  const save = document.querySelector('[data-crop-save]');
  if (!save) return 'НЕТ ОКНА КАДРИРОВАНИЯ';
  save.click();
  return 'ok';
})()`;

// Кружок мастера в колонке «Дня»: показано фото или инициалы
const DAY_AVATAR = `JSON.stringify((function(){
  const col = [...document.querySelectorAll('.panel-sp-day .schedule-col')]
    .find((c) => (c.querySelector('.schedule-col-head .name') || {}).textContent === ${JSON.stringify(MASTER.name)});
  if (!col) return { found: false };
  const avatar = col.querySelector('.schedule-col-head .avatar');
  const img = avatar && avatar.querySelector('img');
  return { found: true, photo: Boolean(img), src: img ? img.getAttribute('src').slice(-24) : (avatar ? avatar.textContent : null) };
})())`;

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
  // Рабочая неделя - иначе мастера нет в колонках «Дня» вовсе
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00')`,
      [MASTER.id, weekday]
    );
  }
  const service = (await db.query('SELECT id FROM services ORDER BY id LIMIT 1')).rows[0];
  await db.query('INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, 1000, 60)', [MASTER.id, service.id]);
  const avatarRows = async () =>
    (await db.query(`SELECT count(*)::int AS n FROM staff_media WHERE staff_id=$1 AND kind='avatar'`, [MASTER.id])).rows[0].n;

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
      // «День» - аккордеон, внутри свёрнутого замеры бессмысленны
      await s.eval(`(function(){ document.querySelector('.panel-sp-day')?.closest('details') && (document.querySelector('.panel-sp-day').closest('details').open = true); })()`);
      await s.sleep(1500);

      const before = JSON.parse(await s.eval(DAY_AVATAR));
      console.log('«День» до загрузки:', JSON.stringify(before));
      check('колонка мастера есть в «Дне»', before.found === true);
      check('до загрузки в кружке инициалы, не фото', before.photo === false, JSON.stringify(before));

      // ── 1. фото появляется в «Дне» сразу после загрузки ────────────────
      const picked = await s.eval(PICK_AND_SAVE, true);
      check('окно кадрирования прошло до конца', picked === 'ok', String(picked));
      await s.sleep(6000);
      check('фото сохранено на сервере', (await avatarRows()) === 1);
      const afterUpload = JSON.parse(await s.eval(DAY_AVATAR));
      console.log('«День» после загрузки:', JSON.stringify(afterUpload));
      check('1. фото видно в «Дне» без перезагрузки страницы', afterUpload.photo === true, JSON.stringify(afterUpload));

      // ── 1б. кнопка «Обновить» тоже показывает актуальное фото ──────────
      await s.eval(`(function(){
        // Стираем кружок вручную, чтобы увидеть, что именно кнопка его вернула
        document.querySelectorAll('.panel-sp-day .schedule-col-head .avatar img').forEach((img) => img.remove());
      })()`);
      await s.eval(`document.getElementById('refreshBtn').click()`);
      await s.sleep(7000);
      const afterRefresh = JSON.parse(await s.eval(DAY_AVATAR));
      console.log('«День» после кнопки обновления:', JSON.stringify(afterRefresh));
      check('1б. кнопка обновления возвращает фото в «День»', afterRefresh.photo === true, JSON.stringify(afterRefresh));

      // ── 2. «Удалить» откладывает удаление до сохранения ────────────────
      const marked = await s.eval(`(function(){
        const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
        card.setAttribute('open', '');
        const button = card.querySelector('[data-media-delete]');
        if (!button) return 'НЕТ КНОПКИ УДАЛЕНИЯ';
        button.click();
        const item = button.closest('.team-media-item');
        return JSON.stringify({
          marked: item.classList.contains('is-pending-delete'),
          label: button.textContent,
          saveEnabled: !card.querySelector('[data-save]').disabled,
        });
      })()`);
      await s.sleep(800);
      const markState = JSON.parse(marked);
      console.log('после клика «Удалить»:', marked);
      check('2. снимок только помечен, а не удалён', markState.marked === true);
      check('2. кнопка предлагает вернуть фото', markState.label === 'Вернуть', markState.label);
      check('2. «Сохранить изменения» стала активной', markState.saveEnabled === true);
      check('2. на сервере фото ещё на месте', (await avatarRows()) === 1);

      // ── 2б. кнопка обновления возвращает фото обратно ──────────────────
      await s.eval(`document.getElementById('refreshBtn').click()`);
      await s.sleep(7000);
      const restored = await s.eval(`JSON.stringify((function(){
        const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
        const item = card && card.querySelector('.team-media-item');
        return {
          hasPhoto: Boolean(item),
          marked: item ? item.classList.contains('is-pending-delete') : null,
          label: item ? item.querySelector('[data-media-delete]').textContent : null,
        };
      })())`);
      console.log('после кнопки обновления:', restored);
      const restoredState = JSON.parse(restored);
      check('2б. кнопка обновления сняла пометку - фото вернулось', restoredState.hasPhoto === true && restoredState.marked === false, restored);
      check('2б. фото на сервере не тронуто', (await avatarRows()) === 1);

      // ── 2в. пометить снова и сохранить - вот теперь удаляется ──────────
      await s.eval(`(function(){
        const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
        card.setAttribute('open', '');
        card.querySelector('[data-media-delete]').click();
      })()`);
      await s.sleep(600);
      await s.eval(`document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"] [data-save]').click()`);
      await s.sleep(8000);
      check('2в. после «Сохранить изменения» фото удалено с сервера', (await avatarRows()) === 0);
      const dayAfterDelete = JSON.parse(await s.eval(DAY_AVATAR));
      console.log('«День» после удаления:', JSON.stringify(dayAfterDelete));
      check('2в. в «Дне» вернулись инициалы', dayAfterDelete.photo === false, JSON.stringify(dayAfterDelete));

      // ── 3. подпись в окне кадрирования убрана ──────────────────────────
      const hint = await s.eval(`(async function(){
        const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
        card.setAttribute('open', '');
        const canvas = document.createElement('canvas');
        canvas.width = 300; canvas.height = 300;
        canvas.getContext('2d').fillRect(0, 0, 300, 300);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const t = new DataTransfer(); t.items.add(new File([blob], 'hint.png', { type: 'image/png' }));
        const input = card.querySelector('input[name="avatar"]');
        input.files = t.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1500));
        const head = document.querySelector('.crop-head');
        const text = head ? head.textContent.trim() : 'НЕТ ОКНА';
        document.querySelector('[data-crop-cancel]')?.click();
        return text;
      })()`, true);
      console.log('шапка окна кадрирования:', JSON.stringify(hint));
      check('3. в окне остался только заголовок, без пояснения', hint === 'Фото профиля', hint);
    });
  });
});
} catch (error) {
  crashed = true;
  console.error('Прогон упал:', error);
}

const ok = summary() && !crashed;
process.exit(ok ? 0 : 1);
