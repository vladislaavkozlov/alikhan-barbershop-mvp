// Живая проверка правки Влада от 15.08.2026: «нужно увеличить пунктирное окно выбора
// времени записи, сделать выше в высоту и сделать так, чтобы она была как бы под
// курсором и не уплывала от него» (прислал рисунок: стрелка курсора стоит НАД рамкой).
//
// Причина прежнего поведения: время под курсором округлялось к БЛИЖАЙШЕМУ 15-минутному
// делению, поэтому на 10:08 рамка прыгала вниз, на 10:15, и оказывалась ниже курсора.
// Теперь округление вниз, а высота рамки 44px вместо 28px.
//
// Проверяется настоящим курсором (Input.dispatchMouseEvent, не программный mousemove):
//   1. высота рамки 44px
//   2. курсор ВНУТРИ рамки в каждой из проверенных точек колонки, включая «неудобные»
//      позиции внутри 15-минутного шага, на которых баг и вылезал
//   3. рамка не вылезает за низ колонки на последних слотах дня
//   4. клик даёт ровно то время, которое показывала рамка
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();

const OWNER = { id: 'qa-ramka-owner', role: 'owner', name: 'QA Рамка Владелец' };
const MASTER = { id: 'qa-ramka-master', role: 'master', name: 'QA Рамка Мастер' };

const DAY_START_MIN = 600; // 10:00 - та же шкала, что в assets/crm-calendar.js
const PX_PER_MIN = 64 / 60;
const STEP = 15;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

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
  // Рабочая неделя нужна обязательно: без неё fillTrack выходит раньше, чем вешает
  // обработчики пустого слота, и проверять рамку было бы не на чем
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00')`,
      [MASTER.id, weekday]
    );
  }
  const service = (await db.query('SELECT id FROM services ORDER BY id LIMIT 1')).rows[0];
  await db.query('INSERT INTO master_services (master_id, service_id, price, duration_min) VALUES ($1, $2, 1000, 60)', [MASTER.id, service.id]);

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
      await s.sleep(3500);
      await s.setViewport(1400, 1600, false);
      await s.sleep(600);

      // Разделы владельца - аккордеоны <details>, и «День» по умолчанию свёрнут.
      // Внутри свёрнутой панели у трека всё равно ненулевой getBoundingClientRect, но
      // физически на этих координатах лежат другие блоки - настоящий курсор попадал бы
      // мимо. Открываем панель ДО замеров
      const dayOpened = await s.eval(`(function(){
        const panel = document.querySelector('.panel-sp-day');
        if (!panel) return 'НЕТ ПАНЕЛИ ДНЯ';
        // .panel-sp-day - обычный div внутри аккордеона; открывать нужно ближайший
        // <details>, иначе панель остаётся свёрнутой, а замеры внутри неё - ложными
        const box = panel.closest('details');
        if (!box) return 'НЕТ АККОРДЕОНА';
        box.open = true;
        box.scrollIntoView({ block: 'start' });
        return 'ok';
      })()`);
      check('раздел «День» раскрыт', dayOpened === 'ok', String(dayOpened));
      await s.sleep(1500);

      // Колонку ищем ПО ИМЕНИ своего мастера: эфемерная база сеет ещё нескольких, и
      // первый .schedule-track в DOM запросто окажется чужим и пустым
      const found = await s.eval(`(function(){
        const day = document.querySelector('.panel-sp-day') || document;
        const col = [...day.querySelectorAll('.schedule-col')].find(c => (c.querySelector('.schedule-col-head .name')||{}).textContent === ${JSON.stringify(MASTER.name)});
        if (!col) return 'НЕТ КОЛОНКИ';
        col.querySelector('.schedule-track').dataset.qaTrack = '1';
        col.scrollIntoView({ block: 'center' });
        return 'ok';
      })()`);
      check('колонка своего мастера найдена в дне', found === 'ok', String(found));
      await s.sleep(500);

      const trackRect = async () => JSON.parse(await s.eval(`JSON.stringify(document.querySelector('[data-qa-track]').getBoundingClientRect())`));
      const previewRect = async () => JSON.parse(await s.eval(`JSON.stringify((function(){
        const p = document.querySelector('[data-qa-track] .appt--slot-preview');
        if (!p || p.hidden) return null;
        const r = p.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, height: r.height };
      })())`));

      const rect = await trackRect();
      // Точки внутри 15-минутного шага: ровно на делении, чуть ниже, в середине шага и
      // почти на следующем делении - именно на последних двух рамка раньше убегала вниз
      const offsets = [2, 8, 12, 20, 27, 100, 205, 333];
      let inside = 0;
      let heightOk = 0;
      let timeOk = 0;
      for (const offset of offsets) {
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + offset);
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
        await s.sleep(120);
        const preview = await previewRect();
        if (!preview) { console.log(`offset ${offset}: рамки нет`); continue; }
        const cursorInside = y >= preview.top - 0.5 && y <= preview.bottom + 0.5;
        if (cursorInside) inside += 1;
        if (Math.abs(preview.height - 44) < 0.6) heightOk += 1;
        // Время, которое показывает рамка, - округление ВНИЗ от позиции курсора
        const expectedMin = Math.floor((DAY_START_MIN + offset / PX_PER_MIN) / STEP) * STEP;
        const expectedTop = rect.top + Math.round((expectedMin - DAY_START_MIN) * PX_PER_MIN);
        if (Math.abs(preview.top - expectedTop) < 1.5) timeOk += 1;
        console.log(`offset ${offset}px (${hhmm(expectedMin)}): курсор ${y}, рамка ${preview.top.toFixed(1)}..${preview.bottom.toFixed(1)}, высота ${preview.height}`);
      }
      check('1. рамка высотой 44px во всех точках', heightOk === offsets.length, `совпало ${heightOk} из ${offsets.length}`);
      check('2. курсор внутри рамки во всех точках', inside === offsets.length, `совпало ${inside} из ${offsets.length}`);
      check('2. рамка стоит на времени, округлённом вниз', timeOk === offsets.length, `совпало ${timeOk} из ${offsets.length}`);

      // ── 3. низ дня: рамка не вылезает за колонку ───────────────────────
      const bottomY = Math.round(rect.bottom - 3);
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(rect.left + rect.width / 2), y: bottomY, pointerType: 'mouse' });
      await s.sleep(150);
      const atBottom = await previewRect();
      check('3. у нижнего края рамка не вылезает за колонку', atBottom && atBottom.bottom <= rect.bottom + 0.5, JSON.stringify({ preview: atBottom, trackBottom: rect.bottom }));
      check('3. у нижнего края курсор всё ещё внутри рамки', atBottom && bottomY >= atBottom.top - 0.5 && bottomY <= atBottom.bottom + 0.5, JSON.stringify(atBottom));

      // ── 4. клик даёт время, которое показывала рамка ───────────────────
      const clickOffset = 27; // 10:15..10:30, «неудобная» точка старого округления
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + clickOffset);
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
      await s.sleep(120);
      await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
      await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' });
      await s.sleep(1200);
      // Виджет времени хранит выбранное в data-value, а не в value (crm-widgets.js)
      const chosen = await s.eval(`(document.getElementById('wfTimeValue')?.dataset.value) || 'нет значения'`);
      const expected = hhmm(Math.floor((DAY_START_MIN + clickOffset / PX_PER_MIN) / STEP) * STEP);
      check('4. клик подставил в форму время из рамки', chosen === expected, `в форме ${chosen}, ожидалось ${expected}`);
    });
  });
});
} catch (error) {
  crashed = true;
  console.error('Прогон упал:', error);
}

const ok = summary() && !crashed;
process.exit(ok ? 0 : 1);
