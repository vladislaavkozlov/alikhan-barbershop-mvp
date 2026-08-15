// Живая проверка правки Влада от 15.08.2026: фото, загруженное в профиль
// сотрудника, должно показываться в кружке-заглушке в разделах «День» и «Команда»
// (раньше там всегда были инициалы, а фото жило только внутри карточки профиля).
//
// Фото загружается настоящим запросом (POST /staff/:id/media?kind=avatar), сервер
// прогоняет его через sharp и кладёт в свою папку - поэтому стенду нужен свой
// STAFF_MEDIA_ROOT: по умолчанию сервер пишет в /data/staff-media, куда на машине
// разработчика доступа нет.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

process.env.STAFF_MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'alikhan-media-'));

const { withBrowser } = await import('./cdp.mjs');
const { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } = await import('./verify-lib.mjs');

const { check, summary } = makeChecker();
const OWNER_EMAIL = 'qa-avatar-owner@alikhan.test';
const MASTER_ID = 'qa-avatar-master';

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const ownerPin = randomPin();
  await db.query(
    `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash) VALUES
     ('qa-avatar-owner', NULL, 'QA Аватар Владелец (verify)', 'owner', true, false, true, $1, $2),
     ($3, NULL, 'QA Аватар Мастер (verify)', 'master', true, true, true, 'qa-avatar-master@alikhan.test', $4)`,
    [OWNER_EMAIL, hashPin(ownerPin), MASTER_ID, hashPin(randomPin())]
  );
  // Мастер должен быть виден в «Дне» - для этого нужен рабочий график
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00')`,
      [MASTER_ID, weekday]
    );
  }
  const service = (await db.query('SELECT id FROM services ORDER BY id LIMIT 1')).rows[0];
  await db.query('INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, 1000, 40)',
    [MASTER_ID, service.id]);

  const token = (await (await fetch(`${apiUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, pin: ownerPin }),
  })).json()).token;

  // ── Владелец загружает фото профиля мастеру ────────────────────────────
  // Узнаваемая картинка: сплошной зелёный квадрат, чтобы на скриншоте было видно,
  // что в кружке именно фото, а не инициалы
  const photo = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 61, g: 122, b: 74 } } }).png().toBuffer();
  const upload = await fetch(`${apiUrl}/staff/${MASTER_ID}/media?kind=avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` },
    body: photo,
  });
  const uploaded = await upload.json().catch(() => null);
  check('фото профиля загрузилось через настоящий запрос', upload.ok, `${upload.status} ${JSON.stringify(uploaded)}`);

  const stored = await db.query(
    `SELECT storage_key FROM staff_media WHERE staff_id = $1 AND kind = 'avatar'`, [MASTER_ID]
  );
  check('фото записано в состав сотрудника как основное', stored.rows.length === 1, `строк: ${stored.rows.length}`);

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await s.setViewport(1280, 1400, false);
      for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await s.sleep(150);
      await s.eval(`(function(){
        document.getElementById('loginEmail').value = ${JSON.stringify(OWNER_EMAIL)};
        document.getElementById('loginPin').value = ${JSON.stringify(ownerPin)};
        document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
      })()`);
      await s.sleep(2500);
      await s.setViewport(1280, 1400, false);

      // Ждём картинку, а не просто элемент: важно, что фото РЕАЛЬНО загрузилось
      // по своему адресу (naturalWidth), а не показывает битую иконку
      const avatarState = async (selector) => {
        for (let i = 0; i < 40; i++) {
          const state = JSON.parse(await s.eval(`JSON.stringify((function(){
            const box = document.querySelector('${selector}');
            if (!box) return null;
            const img = box.querySelector('img');
            if (!img) return { hasPhoto: false, text: box.textContent.trim() };
            return {
              hasPhoto: true,
              complete: img.complete,
              naturalWidth: img.naturalWidth,
              src: img.getAttribute('src') || '',
              round: getComputedStyle(box).borderRadius,
              size: Math.round(box.getBoundingClientRect().width),
              fit: getComputedStyle(img).objectFit,
            };
          })())`));
          if (state?.hasPhoto && state.naturalWidth > 0) return state;
          if (state && i > 20) return state;
          await s.sleep(250);
        }
        return null;
      };

      // ── Команда ──────────────────────────────────────────────────────────
      await s.eval(`document.querySelector('label[for="pt-b"]')?.click()`);
      const team = await avatarState(`.team-editor-card[data-staff-id="${MASTER_ID}"] .avatar`);
      console.log('«Команда»:', team);
      check('в «Команде» в кружке стоит фото, а не инициалы', team?.hasPhoto === true, JSON.stringify(team));
      check('фото в «Команде» реально загрузилось с сервера', (team?.naturalWidth ?? 0) > 0, `naturalWidth=${team?.naturalWidth}`);
      check('адрес фото ведёт на сервер, а не на статику фронтенда', /\/media\//.test(team?.src ?? '') && team.src.startsWith('http'), team?.src);
      check('кружок остался кругом и прежнего размера', team?.round?.includes('50%') && team?.size >= 40 && team?.size <= 70, `${team?.round}, ${team?.size}px`);
      check('фото кадрируется по центру, не растягивается', team?.fit === 'cover', team?.fit);

      // ── День ─────────────────────────────────────────────────────────────
      await s.eval(`document.querySelector('label[for="pt-a"]')?.click()`);
      await s.sleep(600);
      await s.eval(`document.getElementById('scheduleCard-day')?.setAttribute('open','')`);
      await s.sleep(900);
      // Колонку ищем через имя своего мастера: в дне может быть несколько колонок
      const dayColSelector = `.schedule-col`;
      const dayIndex = JSON.parse(await s.eval(`JSON.stringify((function(){
        const cols = [...document.querySelectorAll('${dayColSelector}')];
        return cols.findIndex((c) => (c.querySelector('.name')?.textContent || '').includes('QA Аватар Мастер'));
      })())`));
      check('колонка нашего мастера есть в «Дне»', dayIndex >= 0, `индекс: ${dayIndex}`);
      const day = dayIndex >= 0 ? await avatarState(`${dayColSelector}:nth-of-type(${dayIndex + 1}) .schedule-col-head .avatar`) : null;
      console.log('«День»:', day);
      check('в «Дне» в кружке колонки стоит фото', day?.hasPhoto === true, JSON.stringify(day));
      check('фото в «Дне» реально загрузилось с сервера', (day?.naturalWidth ?? 0) > 0, `naturalWidth=${day?.naturalWidth}`);

      // ── Сотрудник без фото по-прежнему с инициалами ──────────────────────
      const ownerCircle = await avatarState('.team-editor-card[data-staff-id="qa-avatar-owner"] .avatar');
      console.log('владелец без фото:', ownerCircle);
      check('у кого фото нет - остались инициалы', ownerCircle?.hasPhoto === false, JSON.stringify(ownerCircle));
      check('инициалы собраны из имени', /^[А-ЯЁA-Z]{1,2}$/.test(ownerCircle?.text ?? ''), ownerCircle?.text);

      if (process.env.SCREENSHOT_DIR) {
        await s.eval(`document.querySelector('label[for="pt-b"]')?.click()`);
        await s.sleep(700);
        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="${MASTER_ID}"]')?.scrollIntoView({ block: 'center' })`);
        await s.sleep(400);
        await s.screenshot(`${process.env.SCREENSHOT_DIR}/avatar-komanda.png`);
        await s.eval(`document.querySelector('label[for="pt-a"]')?.click()`);
        await s.sleep(500);
        await s.eval(`document.querySelector('.schedule-col-head')?.scrollIntoView({ block: 'center' })`);
        await s.sleep(400);
        await s.screenshot(`${process.env.SCREENSHOT_DIR}/avatar-den.png`);
        console.log('скриншоты сняты');
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
