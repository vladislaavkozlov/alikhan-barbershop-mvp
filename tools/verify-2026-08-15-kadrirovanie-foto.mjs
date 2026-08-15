// Живая проверка правки Влада от 15.08.2026: «при добавлении фото профиля нужно
// сделать возможность её отцентровать, как в телеграме или вк».
//
// Проверяется весь путь целиком, на эфемерной базе и настоящем сервере:
//   1. выбор файла открывает окно кадрирования (а не грузит фото молча, как раньше)
//   2. фото двигается указателем, ползунок приближает
//   3. «Отмена» ничего не грузит - в базе фото не появляется
//   4. «Поставить фото» шлёт КВАДРАТ, и это именно тот кадр, который человек выбрал:
//      сдвинутый кадр отличается от кадра по умолчанию
//   5. на телефоне (360px) окно помещается в экран, кнопки не меньше 44px
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

// Боевое хранилище фото - диск Amvera (/data/staff-media), на машине разработчика
// такого каталога нет и сервер не смог бы сохранить файл. Эфемерный сервер поднимает
// verify-lib с текущим окружением, поэтому подменяем каталог здесь, до его запуска
process.env.STAFF_MEDIA_ROOT = mkdtempSync(join(tmpdir(), 'alikhan-crop-media-'));

const { check, summary } = makeChecker();

const OWNER = { id: 'qa-crop-owner', role: 'owner', name: 'QA Кадр Владелец' };
const MASTER = { id: 'qa-crop-master', role: 'master', name: 'QA Кадр Мастер' };

// Тестовое фото 1000x400: широкая полоса, левая треть красная, середина зелёная,
// правая синяя. По цвету готового квадрата сразу видно, какой кусок вырезали
const TEST_IMAGE = `(function(){
  const canvas = document.createElement('canvas');
  canvas.width = 1000; canvas.height = 400;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d02020'; ctx.fillRect(0, 0, 333, 400);
  ctx.fillStyle = '#20a040'; ctx.fillRect(333, 0, 334, 400);
  ctx.fillStyle = '#2040d0'; ctx.fillRect(667, 0, 333, 400);
  return new Promise((resolve) => canvas.toBlob((blob) => {
    const file = new File([blob], 'proba.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('.team-editor-card[data-staff-id="qa-crop-master"] input[name="avatar"]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    resolve('ok');
  }, 'image/png'));
})()`;

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
      [acc.id, `${acc.name} (verify, эфемерная база)`, acc.role, acc.role === 'master', `${acc.id}@alikhan.test`, hashPin(pin)]
    );
  }
  const avatarCount = async () =>
    (await db.query(`SELECT count(*)::int AS n FROM staff_media WHERE staff_id=$1 AND kind='avatar'`, [MASTER.id])).rows[0].n;

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      const login = async () => {
        await s.navigate(`${siteUrl}/crm-owner.html`);
        await s.eval('localStorage.clear()');
        await s.navigate(`${siteUrl}/crm-owner.html`);
        await s.setViewport(1280, 1400, false);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await s.sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = ${JSON.stringify(`${OWNER.id}@alikhan.test`)};
          document.getElementById('loginPin').value = ${JSON.stringify(pins.get(OWNER.id))};
          document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
        })()`);
        await s.sleep(3000);
        await s.setViewport(1280, 1400, false);
        await s.sleep(500);
      };
      const openMasterCard = async () => {
        await s.eval(`(function(){
          const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"]');
          if (!card) return 'НЕТ КАРТОЧКИ';
          card.setAttribute('open', '');
          card.scrollIntoView();
          return 'ok';
        })()`);
        await s.sleep(600);
      };
      const cropState = async () => JSON.parse(await s.eval(`JSON.stringify((function(){
        const overlay = document.querySelector('.crop-overlay');
        if (!overlay) return { open: false };
        const card = overlay.querySelector('.crop-card').getBoundingClientRect();
        const stage = overlay.querySelector('.crop-stage').getBoundingClientRect();
        const image = overlay.querySelector('[data-crop-image]');
        const buttons = [...overlay.querySelectorAll('.crop-actions .btn')].map(b => b.getBoundingClientRect().height);
        return {
          open: true,
          transform: getComputedStyle(image).transform,
          zoom: Number(overlay.querySelector('[data-crop-zoom]').value),
          stageSquare: Math.abs(stage.width - stage.height) < 1.5,
          insideScreen: card.left >= 0 && card.right <= (window.visualViewport ? window.visualViewport.width : innerWidth) + 0.5,
          fitsHeight: card.height <= innerHeight,
          minButton: Math.min(...buttons),
        };
      })())`));
      const dragStage = async (dx) => {
        const rect = JSON.parse(await s.eval(`JSON.stringify(document.querySelector('.crop-stage').getBoundingClientRect())`));
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
        for (let step = 1; step <= 6; step += 1) {
          await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x + (dx * step) / 6), y, button: 'left', buttons: 1, pointerType: 'mouse' });
          await s.sleep(40);
        }
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x + dx), y, button: 'left', clickCount: 1, pointerType: 'mouse' });
        await s.sleep(200);
      };

      await login();
      await openMasterCard();

      // ── 1. выбор файла открывает окно кадрирования ────────────────────
      await s.eval(TEST_IMAGE, true);
      await s.sleep(1200);
      const opened = await cropState();
      console.log('после выбора файла:', JSON.stringify(opened));
      check('1. окно кадрирования открылось', opened.open === true);
      check('1. область кадра квадратная', opened.stageSquare === true);
      check('1. фото ещё не загружено на сервер', (await avatarCount()) === 0);

      // ── 1б. круг ровно один (правка 15.08.2026 - «а почему внутри 2 кружка?») ──
      // Замер по картинке: идём от центра вправо и ищем, где начинается затемнение
      // маски, отдельно измеряем радиус золотой рамки. Раньше это были разные круги
      const circles = JSON.parse(await s.eval(`JSON.stringify((function(){
        const stage = document.querySelector('.crop-stage');
        const rect = stage.getBoundingClientRect();
        const mask = getComputedStyle(document.querySelector('.crop-mask'));
        const ring = getComputedStyle(stage, '::after');
        return {
          maskImage: mask.maskImage || mask.webkitMaskImage || '',
          ringRadius: rect.width / 2,
          ringRound: ring.borderRadius,
          borderWidth: ring.borderTopWidth,
        };
      })())`));
      console.log('круги:', JSON.stringify(circles));
      // closest-side привязывает радиус градиента к стороне квадрата - тот же радиус,
      // что у вписанной золотой окружности; farthest-corner (по умолчанию) давал бы
      // круг примерно в 0.71 от неё, то есть второй, меньший круг внутри рамки
      check('1б. затемнение обрезано по вписанной окружности (один круг)', /closest-side/.test(circles.maskImage), circles.maskImage.slice(0, 90));
      check('1б. золотая рамка - окружность по краю области', circles.ringRound.startsWith('50%'), circles.ringRound);

      // ── 1в. фото можно отдалить, а не только приблизить ────────────────
      const zoomRange = JSON.parse(await s.eval(`JSON.stringify((function(){
        const zoom = document.querySelector('[data-crop-zoom]');
        return { min: Number(zoom.min), max: Number(zoom.max), value: Number(zoom.value) };
      })())`));
      console.log('ползунок:', JSON.stringify(zoomRange));
      check('1в. ползунок пускает ниже единицы - фото можно отдалить', zoomRange.min < 0.99, JSON.stringify(zoomRange));
      const zoomedOut = await s.eval(`(function(){
        const zoom = document.querySelector('[data-crop-zoom]');
        zoom.value = zoom.min;
        zoom.dispatchEvent(new Event('input', { bubbles: true }));
        const stage = document.querySelector('.crop-stage').getBoundingClientRect();
        const img = document.querySelector('[data-crop-image]').getBoundingClientRect();
        // На минимуме вся картинка должна помещаться в круг: её диагональ не длиннее
        // диаметра, то есть стороны области
        return JSON.stringify({ diagonal: Math.hypot(img.width, img.height), diameter: stage.width });
      })()`);
      const fit = JSON.parse(zoomedOut);
      console.log('на минимальном отдалении:', zoomedOut);
      check('1в. на минимуме фото целиком помещается в круг', fit.diagonal <= fit.diameter + 1, JSON.stringify(fit));

      // ── 2. фото двигается и приближается ──────────────────────────────
      const before = opened.transform;
      await dragStage(70);
      const afterDrag = await cropState();
      check('2. фото двигается указателем', afterDrag.transform !== before, `было ${before}, стало ${afterDrag.transform}`);
      await s.eval(`(function(){
        const zoom = document.querySelector('[data-crop-zoom]');
        zoom.value = '2';
        zoom.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await s.sleep(300);
      const afterZoom = await cropState();
      check('2. ползунок приближает', afterZoom.zoom === 2 && afterZoom.transform !== afterDrag.transform);

      // ── 3. отмена ничего не грузит ────────────────────────────────────
      await s.eval(`document.querySelector('[data-crop-cancel]').click()`);
      await s.sleep(1500);
      check('3. по «Отмене» окно закрылось', (await cropState()).open === false);
      check('3. по «Отмене» фото на сервер не ушло', (await avatarCount()) === 0);

      // ── 4. сохранение шлёт выбранный кадр ─────────────────────────────
      await openMasterCard();
      await s.eval(TEST_IMAGE, true);
      await s.sleep(1200);
      // Тянем фото вправо - в кадр уезжает ЛЕВАЯ (красная) часть полосы
      await dragStage(120);
      await s.eval(`document.querySelector('[data-crop-save]').click()`);
      await s.sleep(2000);
      check('4. окно закрылось после сохранения', (await cropState()).open === false);
      let stored = 0;
      for (let i = 0; i < 20 && stored === 0; i += 1) { stored = await avatarCount(); if (!stored) await s.sleep(700); }
      const cardNote = await s.eval(`(document.querySelector('.team-editor-card[data-staff-id="${MASTER.id}"] [data-card-note]')||{}).textContent || ''`);
      check('4. фото профиля появилось в базе', stored === 1, `строка статуса карточки: "${cardNote}"`);

      const key = (await db.query(`SELECT storage_key FROM staff_media WHERE staff_id=$1 AND kind='avatar'`, [MASTER.id])).rows[0]?.storage_key;
      const saved = await s.eval(`(async function(){
        const res = await fetch('${apiUrl}/media/${key}');
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const middle = Math.floor(bitmap.height / 2);
        const px = (x) => { const d = canvas.getContext('2d').getImageData(x, middle, 1, 1).data; return [d[0], d[1], d[2]]; };
        return JSON.stringify({ w: bitmap.width, h: bitmap.height, left: px(4), center: px(Math.floor(bitmap.width/2)), right: px(bitmap.width - 5) });
      })()`, true);
      const pixels = JSON.parse(saved);
      console.log('сохранённый файл:', saved);
      check('4. сохранён именно квадрат', pixels.w === pixels.h, `${pixels.w}x${pixels.h}`);
      // Кадр по умолчанию у полосы 1000x400 - середина, то есть чистая зелень во всех
      // трёх точках. После сдвига вправо в кадр обязана попасть красная часть
      const isRed = ([r, g, b]) => r > 150 && g < 110 && b < 110;
      check('4. в кадр попала выбранная (левая, красная) часть фото', isRed(pixels.left), JSON.stringify(pixels));

      // ── 5. телефон ────────────────────────────────────────────────────
      await s.setViewport(360, 780, true);
      await s.sleep(400);
      await openMasterCard();
      await s.eval(TEST_IMAGE, true);
      await s.sleep(1200);
      const mobile = await cropState();
      console.log('мобильный:', JSON.stringify(mobile));
      check('5. на 360px окно помещается по ширине', mobile.insideScreen === true);
      check('5. на 360px окно помещается по высоте', mobile.fitsHeight === true, `высота карточки больше экрана`);
      check('5. кнопки не мельче 44px', mobile.minButton >= 44, `минимальная ${mobile.minButton}`);
      await s.screenshot('/tmp/crop-mobile.png');
      await s.eval(`document.querySelector('[data-crop-cancel]').click()`);
    });
  });
});
} catch (error) {
  crashed = true;
  console.error('Прогон упал:', error);
}

const ok = summary() && !crashed;
process.exit(ok ? 0 : 1);
