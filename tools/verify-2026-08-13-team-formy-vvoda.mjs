// Живая проверка правок форм ввода в разделе «Команда» владельца (13.08.2026):
// убран выбор точки работы, телефон с маской, даты/время разового изменения - на
// кастомных виджетах проекта вместо нативных <input type="date">/<input type="time">.
// Один withBrowser на весь прогон (порт отладки в cdp.mjs захардкожен - два подряд
// гонятся за него, см. reference_barbershop-crm-tech.md).
import { withBrowser } from './cdp.mjs';
import { hashPin, makeChecker, randomPin, withEphemeralServer, withStaticServer } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MASTER_A = 'qa-team-master-a';
const MASTER_B = 'qa-team-master-b';

// Карточку ищем по СВОЕМУ мастеру, не первым совпадением общего селектора: миграции
// сеют собственных именных мастеров, и первая карточка в DOM - чужая.
const cardOf = (id) => `document.querySelector('.team-editor-card[data-staff-id="${id}"]')`;

try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, phone, pin_hash) VALUES
       ('qa-team-owner', 1, 'QA Владелец Формы', 'owner', true, false, true, 'qa-team-owner@test.local', '89001112233', $1),
       ('${MASTER_A}', 1, 'QA Мастер Альфа', 'master', true, true, true, 'qa-team-a@test.local', '89001234567', $2),
       ('${MASTER_B}', 1, 'QA Мастер Бета', 'master', true, true, true, 'qa-team-b@test.local', '+7 900 765-43-21', $3)`,
      [hashPin(ownerPin), hashPin(randomPin()), hashPin(randomPin())],
    );

    await withStaticServer(apiUrl, async (base) => {
      await withBrowser(async (session) => {
        await session.setViewport(1440, 1100, false);
        await session.navigate(`${base}/crm-owner.html`);
        await session.type('#loginEmail', 'qa-team-owner@test.local');
        await session.type('#loginPin', ownerPin);
        await session.click('#loginForm button[type="submit"]');
        await sleep(1600);
        // Реальная навигация после логина сбрасывает device metrics override
        await session.setViewport(1440, 1100, false);
        await session.click('.app-nav-item[data-section="team"]');
        await sleep(900);
        await session.eval(`(() => {
          document.querySelector('.team-editor-card[data-staff-id="${MASTER_A}"]')?.setAttribute('open', '');
          document.querySelector('.team-editor-card[data-staff-id="${MASTER_B}"]')?.setAttribute('open', '');
        })()`);
        await sleep(600);

        // ── 1. Точка работы ушла из интерфейса ────────────────────────────────
        const place = await session.eval(`(() => {
          const card = ${cardOf(MASTER_A)};
          const add = document.querySelector('.team-add-card');
          return {
            cardFound: !!card,
            selects: document.querySelectorAll('.staff-list select[name="locationId"]').length,
            labelText: [...document.querySelectorAll('.staff-list label')].filter((l) => l.textContent.includes('Точка работы')).length,
            hiddenValue: card?.querySelector('input[name="locationId"]')?.value ?? null,
            hiddenType: card?.querySelector('input[name="locationId"]')?.type ?? null,
            addHiddenValue: add?.querySelector('input[name="locationId"]')?.value ?? null,
          };
        })()`);
        check('Карточка QA-мастера найдена в разделе «Команда»', place.cardFound, JSON.stringify(place));
        check('Выбора точки работы в интерфейсе больше нет', place.selects === 0 && place.labelText === 0, JSON.stringify(place));
        check('Точка по-прежнему уезжает на сервер скрытым полем (карточка и форма добавления)', place.hiddenType === 'hidden' && !!place.hiddenValue && !!place.addHiddenValue, JSON.stringify(place));

        // ── 2. Телефон: маска на сохранённом значении и при вводе ─────────────
        const phoneInitial = await session.eval(`(() => {
          const a = ${cardOf(MASTER_A)}?.querySelector('input[name="phone"]');
          const b = ${cardOf(MASTER_B)}?.querySelector('input[name="phone"]');
          const add = document.querySelector('.team-add-card input[name="phone"]');
          return { a: a?.value, aType: a?.type, aMode: a?.inputMode, b: b?.value, addPlaceholder: add?.placeholder, addValue: add?.value };
        })()`);
        check('Сохранённый «89001234567» показан как +7 900 123-45-67', phoneInitial.a === '+7 900 123-45-67', JSON.stringify(phoneInitial));
        check('Уже отформатированный номер не искажается', phoneInitial.b === '+7 900 765-43-21', JSON.stringify(phoneInitial));
        check('Поле телефона объявлено телефонным (type/inputmode)', phoneInitial.aType === 'tel' && phoneInitial.aMode === 'tel', JSON.stringify(phoneInitial));
        check('Пустое поле в форме добавления показывает подсказку формата, но не подставляет +7', phoneInitial.addPlaceholder === '+7 900 000-00-00' && phoneInitial.addValue === '', JSON.stringify(phoneInitial));

        const typed = await session.eval(`(() => {
          const input = document.querySelector('.team-add-card input[name="phone"]');
          const set = (v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); return input.value; };
          const out = { fromEight: set('89261234567'), cleared: set(''), partial: set('925') };
          set('');
          return out;
        })()`);
        check('Ввод «89261234567» превращается в +7 926 123-45-67', typed.fromEight === '+7 926 123-45-67', JSON.stringify(typed));
        check('Очистка поля не оставляет «+7» насильно', typed.cleared === '', JSON.stringify(typed));
        check('Незаконченный ввод форматируется по мере набора', typed.partial === '+7 925', JSON.stringify(typed));
        await session.eval(`${cardOf(MASTER_A)}.querySelector('input[name="name"]').scrollIntoView({ block: 'center' })`);
        await sleep(250);
        await session.screenshot('/tmp/team-formy-osnovnoe.png');
        await session.eval(`(() => {
          const add = document.querySelector('.team-add-card');
          add.setAttribute('open', '');
          add.scrollIntoView({ block: 'center' });
        })()`);
        await sleep(350);
        await session.screenshot('/tmp/team-formy-novyy-sotrudnik.png');

        // ── 2b. Фокус полей в теме салона, а не системная сине-белая обводка ──
        // Фокус проверяем НАСТОЯЩИМ кликом мыши: программный input.focus() в Chrome
        // не всегда включает :focus-visible, и замер соврал бы «кольца нет»
        const nameBox = await session.eval(`(() => {
          const input = ${cardOf(MASTER_A)}.querySelector('input[name="name"]');
          input.scrollIntoView({ block: 'center' });
          return true;
        })()`);
        await sleep(250);
        const nameCoords = await session.eval(`(() => {
          const r = ${cardOf(MASTER_A)}.querySelector('input[name="name"]').getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        await session.clickAt(nameCoords.x, nameCoords.y);
        await sleep(250);
        const focusStyle = await session.eval(`(() => {
          const card = ${cardOf(MASTER_A)};
          const input = card.querySelector('input[name="name"]');
          const cs = getComputedStyle(input);
          const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
          const autofillRule = [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } })
            .some((rule) => rule.selectorText?.includes(':-webkit-autofill') && !rule.selectorText.includes('login-card'));
          return { focused: document.activeElement === input, outlineColor: cs.outlineColor, outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, borderColor: cs.borderColor, accent, autofillRule };
        })()`);
        const looksBlue = /rgb\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(focusStyle.outlineColor ?? '');
        const isBlueRing = looksBlue ? Number(looksBlue[3]) > Number(looksBlue[1]) + 40 : false;
        check('Поле в фокусе обведено золотом, а не системным сине-белым кольцом', focusStyle.focused && focusStyle.outlineStyle === 'solid' && !isBlueRing, JSON.stringify(focusStyle));
        check('Автозаполнение Chrome не белит поля вне формы входа', focusStyle.autofillRule, JSON.stringify(focusStyle));

        // ── 3. Даты и время разового изменения - виджеты, не нативные поля ────
        const widgets = await session.eval(`(() => {
          const card = ${cardOf(MASTER_A)};
          const block = card?.querySelector('[data-schedule-exception]');
          return {
            nativeDates: card?.querySelectorAll('input[type="date"]').length,
            nativeTimes: card?.querySelectorAll('input[type="time"]').length,
            dateWidgets: block?.querySelectorAll('.custom-date').length,
            timeWidgets: block?.querySelectorAll('.custom-select').length,
            triggerLabel: block?.querySelector('.custom-date-trigger')?.textContent.trim(),
            triggerFont: block ? getComputedStyle(block.querySelector('.custom-date-trigger')).fontFamily : null,
            fieldFont: card ? getComputedStyle(card.querySelector('input[name="name"]')).fontFamily : null,
            timeValue: block?.querySelector('.custom-select')?.dataset.value,
            breakHidden: block?.querySelector('[data-break-fields]')?.hidden,
          };
        })()`);
        check('Нативных <input type="date">/<input type="time"> в карточке не осталось', widgets.nativeDates === 0 && widgets.nativeTimes === 0, JSON.stringify(widgets));
        check('Даты и время рисуют виджеты проекта (2 календаря + 2 списка времени)', widgets.dateWidgets === 2 && widgets.timeWidgets === 2, JSON.stringify(widgets));
        check('Дата подписана по-русски (ДД.ММ.ГГГГ), время предзаполнено', /^\d{2}\.\d{2}\.\d{4}$/.test(widgets.triggerLabel ?? '') && widgets.timeValue === '13:00', JSON.stringify(widgets));
        check('Шрифт виджета совпадает со шрифтом обычного поля карточки', widgets.triggerFont === widgets.fieldFont, JSON.stringify(widgets));
        check('Поля перерыва скрыты, пока выбран «Выходной»', widgets.breakHidden === true, JSON.stringify(widgets));

        // ── 4. Календарь открывается реальным кликом и не вылезает за карточку ─
        const triggerBox = await session.eval(`(() => {
          const t = ${cardOf(MASTER_A)}.querySelector('[data-schedule-exception] .custom-date-trigger');
          t.scrollIntoView({ block: 'center' });
          const r = t.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        await sleep(250);
        const freshBox = await session.eval(`(() => {
          const t = ${cardOf(MASTER_A)}.querySelector('[data-schedule-exception] .custom-date-trigger');
          const r = t.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        await session.clickAt(freshBox.x, freshBox.y);
        await sleep(300);
        const panel = await session.eval(`(() => {
          const card = ${cardOf(MASTER_A)};
          const wrap = card.querySelector('[data-schedule-exception] .custom-date');
          const p = wrap.querySelector('.custom-date-panel');
          const pr = p.getBoundingClientRect();
          const cr = card.getBoundingClientRect();
          const cells = [...p.querySelectorAll('.custom-date-cell')];
          const clickable = cells.filter((c) => c.tagName === 'BUTTON');
          const disabled = cells.filter((c) => c.classList.contains('custom-date-cell--disabled'));
          return {
            open: wrap.classList.contains('open') && !p.hidden,
            insideCard: pr.right <= cr.right + 1 && pr.left >= cr.left - 1 && pr.bottom <= cr.bottom + 1,
            monthLabel: p.querySelector('.custom-date-month-label')?.textContent.trim(),
            clickable: clickable.length,
            disabledPast: disabled.length,
            background: getComputedStyle(p).backgroundColor,
            firstFreeDate: clickable[0]?.dataset.date ?? null,
          };
        })()`);
        check('Клик по полю даты открывает календарь проекта', panel.open, JSON.stringify(panel));
        // Курсор после clickAt физически стоит над триггером - это живая проверка
        // :hover, из-за которого глобальное button:hover заливало поле золотом
        const hover = await session.eval(`(() => {
          const card = ${cardOf(MASTER_A)};
          const trigger = card.querySelector('[data-schedule-exception] .custom-date-trigger');
          const input = card.querySelector('input[name="name"]');
          const cs = getComputedStyle(trigger);
          return { hovered: trigger.matches(':hover'), bg: cs.backgroundColor, color: cs.color, inputBg: getComputedStyle(input).backgroundColor };
        })()`);
        check('Поле даты под курсором остаётся полем, а не заливается как кнопка', hover.hovered && hover.bg === hover.inputBg, JSON.stringify(hover));
        // Стрелка списка времени нарисована background-image - проверяем, что hover
        // (шорткат background) её не стирает
        check('Календарь целиком помещается внутрь карточки сотрудника', panel.insideCard, JSON.stringify(panel));
        check('Прошедшие дни в календаре некликабельны, будущие доступны', panel.disabledPast > 0 && panel.clickable > 0, JSON.stringify(panel));
        await session.screenshot('/tmp/team-formy-kalendar.png');

        const picked = await session.eval(`(() => {
          const wrap = ${cardOf(MASTER_A)}.querySelector('[data-schedule-exception] .custom-date');
          const cells = [...wrap.querySelectorAll('.custom-date-cell')].filter((c) => c.tagName === 'BUTTON');
          const target = cells[cells.length - 1];
          target.click();
          return { value: wrap.dataset.value, label: wrap.querySelector('.custom-date-trigger').textContent.trim(), closed: !wrap.classList.contains('open') };
        })()`);
        check('Выбор дня записывает значение и закрывает календарь', /^\d{4}-\d{2}-\d{2}$/.test(picked.value ?? '') && picked.closed, JSON.stringify(picked));

        // ── 4b. Недельный график: раскрытый день тоже на виджетах, без нативных ─
        const weekly = await session.eval(`(() => {
          const card = ${cardOf(MASTER_A)};
          const day = card.querySelector('.weekday-icon');
          day?.click();
          const row = card.querySelector('.weekly-day-row');
          return {
            dayFound: !!day,
            rowFound: !!row,
            nativeSelects: document.querySelectorAll('.staff-list select').length,
            nativeDates: document.querySelectorAll('.staff-list input[type="date"]').length,
            nativeTimes: document.querySelectorAll('.staff-list input[type="time"]').length,
            rowTimeWidgets: row?.querySelectorAll('.custom-select').length ?? 0,
          };
        })()`);
        await sleep(300);
        check('Во всём разделе «Команда» не осталось нативных select/date/time', weekly.nativeSelects === 0 && weekly.nativeDates === 0 && weekly.nativeTimes === 0, JSON.stringify(weekly));
        if (weekly.rowFound) {
          check('Время в недельном графике - тот же виджет, что и в разовом изменении', weekly.rowTimeWidgets >= 2, JSON.stringify(weekly));
          const grid = await session.eval(`(() => {
            const card = ${cardOf(MASTER_A)};
            const weeklyGrid = card.querySelector('.weekly-time-grid');
            const exceptionGrid = card.querySelector('[data-schedule-exception] .team-editor-grid');
            const cols = (node) => getComputedStyle(node).gridTemplateColumns.split(' ').length;
            return { weeklyCols: cols(weeklyGrid), exceptionCols: cols(exceptionGrid), weeklyWidth: Math.round(weeklyGrid.getBoundingClientRect().width), exceptionWidth: Math.round(exceptionGrid.getBoundingClientRect().width) };
          })()`);
          // Ширины сравниваем с допуском: блок разового изменения сидит в своей рамке
          // с padding 18px, поэтому пиксель-в-пиксель они не совпадут и не должны
          check('Пара «Работает с/до» стоит в две колонки, как соседние формы карточки', grid.weeklyCols === 2 && grid.weeklyCols === grid.exceptionCols && Math.abs(grid.weeklyWidth - grid.exceptionWidth) <= 40, JSON.stringify(grid));
          await session.eval(`${cardOf(MASTER_A)}.querySelector('.weekly-day-row').scrollIntoView({ block: 'center' })`);
          await sleep(250);
          // Стрелка списка времени нарисована background-image, а общее правило кнопок
          // красило фон шорткатом background - под курсором стрелка исчезала (найдено на
          // скриншоте живого прогона). Наводим настоящий курсор и смотрим computed-стиль
          const timeCoords = await session.eval(`(() => {
            const t = ${cardOf(MASTER_A)}.querySelector('.weekly-time-grid .custom-select-trigger');
            const r = t.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`);
          await session.clickAt(timeCoords.x, timeCoords.y);
          await sleep(250);
          const timeHover = await session.eval(`(() => {
            const t = ${cardOf(MASTER_A)}.querySelector('.weekly-time-grid .custom-select-trigger');
            const cs = getComputedStyle(t);
            return { hovered: t.matches(':hover'), image: cs.backgroundImage !== 'none', bg: cs.backgroundColor };
          })()`);
          check('Стрелка у поля времени не пропадает под курсором', timeHover.hovered && timeHover.image, JSON.stringify(timeHover));
          // Ползунок дня стоял голым напротив «Пн» - непонятно, что он переключает
          const dayLabel = await session.eval(`(() => {
            const card = ${cardOf(MASTER_A)};
            const title = card.querySelector('.weekly-day-title');
            const toggle = card.querySelector('.weekly-day-row input[type="checkbox"]');
            const before = { name: title?.querySelector('.tr-label')?.textContent.trim(), state: title?.querySelector('.tr-sub')?.textContent.trim() };
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
            const off = title?.querySelector('.tr-sub')?.textContent.trim();
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
            return { ...before, off, back: title?.querySelector('.tr-sub')?.textContent.trim() };
          })()`);
          check('День подписан полным названием, а ползунок - словами', dayLabel.name === 'Понедельник' && dayLabel.state === 'Рабочий день', JSON.stringify(dayLabel));
          check('Выключенный ползунок сразу объясняет последствие', dayLabel.off === 'Выходной, записи не будет' && dayLabel.back === 'Рабочий день', JSON.stringify(dayLabel));
          const breakLabel = await session.eval(`(() => {
            const card = ${cardOf(MASTER_A)};
            const hint = card.querySelector('[id$="-breakHint"]');
            const toggle = card.querySelector('[id$="-breakOn"]');
            const off = hint?.textContent.trim();
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
            const on = hint?.textContent.trim();
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
            return { off, on };
          })()`);
          check('Ползунок перерыва тоже подписан словами', breakLabel.off === 'Пока не задан, день без перерыва' && breakLabel.on === 'В это время записи не будет', JSON.stringify(breakLabel));
          await session.eval(`document.querySelectorAll('.custom-select.open').forEach((w) => { w.classList.remove('open'); w.querySelector('.custom-select-list').hidden = true; })`);
          await sleep(150);
          await session.screenshot('/tmp/team-formy-grafik.png');
        }

        // ── 5. Радиокнопки типа изменения не склеены между карточками ─────────
        const radios = await session.eval(`(() => {
          const a = ${cardOf(MASTER_A)}.querySelector('[data-schedule-exception]');
          const b = ${cardOf(MASTER_B)}.querySelector('[data-schedule-exception]');
          const pick = (root, value) => {
            const input = [...root.querySelectorAll('.team-exception-types input')].find((i) => i.value === value);
            input.click();
          };
          pick(a, 'break');
          const checkedOf = (root) => root.querySelector('.team-exception-types input:checked')?.value;
          return {
            names: [a.querySelector('.team-exception-types input').name, b.querySelector('.team-exception-types input').name],
            aChecked: checkedOf(a),
            bChecked: checkedOf(b),
            aBreakVisible: a.querySelector('[data-break-fields]').hidden === false,
            bBreakVisible: b.querySelector('[data-break-fields]').hidden === false,
          };
        })()`);
        check('У каждой карточки своя радиогруппа типа изменения', radios.names[0] !== radios.names[1], JSON.stringify(radios));
        check('Выбор «Перерыв» у одного мастера не сбрасывает выбор у другого', radios.aChecked === 'break' && radios.bChecked === 'dayOff', JSON.stringify(radios));
        check('Поля времени перерыва появляются только у той карточки, где выбран перерыв', radios.aBreakVisible && !radios.bBreakVisible, JSON.stringify(radios));

        // ── 6. Разовый выходной реально сохраняется через новые виджеты ───────
        const saved = await session.eval(`(async () => {
          const card = document.querySelector('.team-editor-card[data-staff-id="${MASTER_B}"]');
          const block = card.querySelector('[data-schedule-exception]');
          block.querySelector('[data-exception-save]').click();
          await new Promise((r) => setTimeout(r, 1500));
          return {
            note: block.querySelector('[data-exception-note]').textContent.trim(),
            list: block.querySelector('[data-exception-list]').textContent.trim(),
          };
        })()`, true);
        check('Разовое изменение сохраняется новыми виджетами', saved.note === 'Разовое изменение сохранено', JSON.stringify(saved));
        check('Сохранённый день показан человеческой датой ДД.ММ.ГГГГ и типом', /\d{2}\.\d{2}\.\d{4} - Выходной/.test(saved.list), JSON.stringify(saved));

        const stored = await db.query('SELECT date FROM schedule_shifts WHERE master_id = $1', [MASTER_B]);
        check('Выходной действительно лёг в базу (schedule_shifts)', stored.rowCount === 1, JSON.stringify(stored.rows));

        await session.screenshot('/tmp/team-formy-desktop.png');

        // ── 7. Мобильный вьюпорт: календарь не выходит за экран ───────────────
        await session.setViewport(390, 844, true);
        await sleep(400);
        const mobile = await session.eval(`(() => {
          const card = ${cardOf(MASTER_A)};
          const wrap = card.querySelector('[data-schedule-exception] .custom-date');
          wrap.querySelector('.custom-date-trigger').click();
          const p = wrap.querySelector('.custom-date-panel');
          const pr = p.getBoundingClientRect();
          const cr = card.getBoundingClientRect();
          const width = window.visualViewport ? window.visualViewport.width : window.innerWidth;
          return {
            open: !p.hidden,
            insideCard: pr.right <= cr.right + 1 && pr.left >= cr.left - 1,
            insideScreen: pr.right <= width + 1 && pr.left >= -1,
            noHorizontalScroll: document.documentElement.scrollWidth <= width + 1,
          };
        })()`);
        check('Мобильный: календарь остаётся внутри карточки', mobile.open && mobile.insideCard, JSON.stringify(mobile));
        check('Мобильный: календарь остаётся внутри экрана', mobile.insideScreen, JSON.stringify(mobile));
        check('Мобильный: страница не получает горизонтальный скролл', mobile.noHorizontalScroll, JSON.stringify(mobile));
        await session.screenshot('/tmp/team-formy-mobile.png');
      });
    });
  });
} catch (error) {
  console.error('CRASH:', error);
  process.exitCode = 1;
}

if (!summary()) process.exitCode = 1;
