// Жалоба Влада 21.08.2026: «когда грузишь фото профиля, кнопка "Сохранить изменения"
// не становится доступной» в разделе «Команда». Прежде чем что-то менять, выясняем
// живьём, что происходит НА САМОМ ДЕЛЕ:
//   1. доезжает ли фото до сервера сразу при выборе (POST /staff/:id/media)
//   2. видно ли его в карточке и в кружке сотрудника без перезагрузки
//   3. в каком состоянии остаётся кнопка «Сохранить изменения» и что говорит подпись
//   4. как ведёт себя УДАЛЕНИЕ фото - оно, в отличие от загрузки, идёт через кнопку
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const PHOTO = new URL('../assets/logo-alikhan.png', import.meta.url).pathname;
// Сервер по умолчанию пишет картинки в /data/staff-media (том Amvera) - на локальной
// машине такой папки нет, и без этой строки прогон падал бы на инфраструктуре, а не на
// коде (первый запуск 21.08.2026 дал ровно это: «не удалось загрузить»)
const { mkdtemp } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
process.env.STAFF_MEDIA_ROOT = await mkdtemp(`${tmpdir()}/alikhan-media-`);
console.log('  медиа-хранилище прогона:', process.env.STAFF_MEDIA_ROOT);

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const bossPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('ph-boss', 1, 'QA Владелец', 'owner', true, false, true, 'ph-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('ph-master', 1, 'QA Мастер Фото', 'master', true, true, true, 'ph-master@alikhan.test', $1)`,
      [hashPin(randomPin())]
    );

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 1000);
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'ph-boss@alikhan.test';
          document.getElementById('loginPin').value = '${bossPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        await s.eval(`document.querySelector('.app-nav-item[data-section="team"]')?.click()`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.team-editor-card[data-staff-id="ph-master"]'))`)); i++) await sleep(200);
        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="ph-master"] summary')?.click()`);
        await sleep(600);

        const before = JSON.parse(await s.eval(`JSON.stringify({
          saveDisabled: document.querySelector('.team-editor-card[data-staff-id="ph-master"] [data-save]')?.disabled,
          photos: document.querySelectorAll('.team-editor-card[data-staff-id="ph-master"] .team-media-item').length,
        })`));
        check('до загрузки: фотографий нет, кнопка сохранения серая (менять нечего)',
          before.photos === 0 && before.saveDisabled === true, JSON.stringify(before));

        // Кладём файл в input[name=avatar] так же, как это делает человек в диалоге выбора
        const doc = await s.send('DOM.getDocument', { depth: -1 });
        const nodeRes = await s.send('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: '.team-editor-card[data-staff-id="ph-master"] input[name="avatar"]',
        });
        await s.send('DOM.setFileInputFiles', { nodeId: nodeRes.nodeId, files: [PHOTO] });
        await sleep(1200);

        const cropOpen = JSON.parse(await s.eval(`JSON.stringify({
          overlay: !!document.querySelector('[data-crop-save]'),
        })`));
        check('после выбора файла открывается кадрирование', cropOpen.overlay, JSON.stringify(cropOpen));

        await s.eval(`document.querySelector('[data-crop-save]')?.click()`);
        // Ждём, пока загрузка дойдёт до сервера и карточка перерисуется
        for (let i = 0; i < 80; i++) {
          const done = JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.team-editor-card[data-staff-id="ph-master"] .team-media-item[data-media-kind="avatar"]'))`));
          if (done) break;
          await sleep(250);
        }

        const server = await (await fetch(`${apiUrl}/public/masters`)).json().catch(() => null);
        const dbRow = await db.query(`SELECT kind, storage_key FROM staff_media WHERE staff_id = 'ph-master'`);
        check('фото УЖЕ на сервере сразу после кадрирования, без нажатия «Сохранить»',
          dbRow.rows.length === 1 && dbRow.rows[0].kind === 'avatar', JSON.stringify(dbRow.rows));

        const after = JSON.parse(await s.eval(`JSON.stringify((function(){
          const card = document.querySelector('.team-editor-card[data-staff-id="ph-master"]');
          return {
            saveDisabled: card?.querySelector('[data-save]')?.disabled,
            note: card?.querySelector('[data-card-note]')?.textContent?.trim(),
            photos: card?.querySelectorAll('.team-media-item').length,
            cardOpen: card?.open,
            summaryAvatarIsPhoto: !!card?.querySelector('summary .avatar--photo img'),
          };
        })())`));
        console.log('  состояние карточки после загрузки:', JSON.stringify(after));
        check('фото видно в карточке сразу, без перезагрузки страницы', after.photos === 1, JSON.stringify(after));
        check('кружок сотрудника в шапке карточки тоже показывает новое фото', after.summaryAvatarIsPhoto, JSON.stringify(after));
        check('карточка осталась раскрытой после перерисовки', after.cardOpen === true, JSON.stringify(after));
        check('подпись в карточке говорит, что фото сохранено (переживает перерисовку)',
          /сохранено/i.test(after.note ?? ''), String(after.note));
        const toast = norm(await s.eval(`[...document.querySelectorAll('.crm-toast, [class*="toast"]')].map(t => t.innerText).join(' | ')`));
        check('всплывающее подтверждение видно внизу экрана, как у остальных действий',
          /сохранено/i.test(toast), toast || 'тоста нет');
        const hint = norm(await s.eval(`document.querySelector('.team-editor-card[data-staff-id="ph-master"] .team-media-upload small')?.textContent`));
        check('блок фото объясняет, что кнопка «Сохранить изменения» для него не нужна',
          /не нужна/i.test(hint), hint);

        // Удаление - другой путь: помечает и ждёт «Сохранить изменения»
        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="ph-master"] [data-media-delete]')?.click()`);
        await sleep(400);
        const afterMark = JSON.parse(await s.eval(`JSON.stringify({
          saveDisabled: document.querySelector('.team-editor-card[data-staff-id="ph-master"] [data-save]')?.disabled,
          note: document.querySelector('.team-editor-card[data-staff-id="ph-master"] [data-card-note]')?.textContent?.trim(),
        })`));
        check('удаление фото будит кнопку «Сохранить изменения»', afterMark.saveDisabled === false, JSON.stringify(afterMark));
        console.log('  для сравнения, после пометки на удаление:', JSON.stringify(afterMark));
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err);
}

const ok = summary() && !crashed;
console.log(ok ? '\nВЕРДИКТ: PASSED' : '\nВЕРДИКТ: FAILED');
process.exit(ok ? 0 : 1);
