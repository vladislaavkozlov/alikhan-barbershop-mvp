// Живой прогон раздела «Аналитика» владельца (22.08.2026, задача Влада:
// «возвращаемость клиентов по сотрудникам» и «в „Как приходят клиенты“ добавить
// откуда - яндекс, 2гис и т.д.»).
//
// Проверяем на эфемерной базе с заведомо известными цифрами: сеем брони так, чтобы
// правильный ответ был посчитан руками заранее, и сверяем то, что человек реально
// видит на экране, а не то, что вернул JSON.
//
// Раскладка фикстуры (все визиты - в пределах последних 3 месяцев, status='done'):
// Окно ожидания (правка Влада 22.08.2026): клиент, у которого единственный визит был
// меньше месяца назад, в расчёт не идёт вовсе - ему рано возвращаться. Здесь это c2
// (был 20 дней назад) и визит c1 к мастеру m2 (5 дней назад).
//   мастер m1: c1 (2 визита), c4 (1 визит, 50 дней назад), c2 (свежий - вне расчёта)
//              → 1 из 2 = 50%, не вернулся c4
//   мастер m2: c3 (2 визита), c1 (свежий - вне расчёта)    → 1 из 1 = 100%
//   мастер m3: визитов нет                                  → прочерк, не 0%
//   салон: c1 (3 визита), c3 (2) вернулись, c4 (1 давно) нет, c2 ждёт своего месяца
//          → 2 из 3 = 67%, «пришли недавно» = 1
//   плюс 1 визит без client_id (walk-in без телефона) - в расчёт не входит, о нём
//   раздел говорит отдельной строкой
// Каналы за МЕСЯЦ (вкладка по умолчанию; считаются все записи периода, включая
// отменённую - площадка свою работу сделала, человек записался):
//   yandex_maps 2, 2gis 2, instagram 1, walkin 1, без источника 1 → всего 7.
//   Визит 40-дневной давности в месячное окно не попадает - он виден на вкладках
//   возвращаемости (3 месяца), но не здесь
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin, daysFromToday } from './verify-lib.mjs';
import { withBrowser } from './cdp.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const bossPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('an-boss', 1, 'QA Владелец', 'owner', true, false, true, 'an-boss@alikhan.test', $1)`,
      [hashPin(bossPin)]
    );
    for (const [id, name] of [['an-m1', 'QA Мастер Первый'], ['an-m2', 'QA Мастер Второй'], ['an-m3', 'QA Мастер Без Записей']]) {
      await db.query(
        `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
         VALUES ($1, 1, $2, 'master', true, true, true, $3, $4)`,
        [id, name, `${id}@alikhan.test`, hashPin(randomPin())]
      );
    }
    for (const [id, name] of [['an-c1', 'QA Клиент 1'], ['an-c2', 'QA Клиент 2'], ['an-c3', 'QA Клиент 3'], ['an-c4', 'QA Клиент 4']]) {
      await db.query('INSERT INTO clients (id, name, phone) VALUES ($1, $2, $3)', [id, name, `+7999000${id.slice(-1)}111`]);
    }

    // График мастерам нужен не ради самих цифр (возвращаемость считается по броням),
    // а ради вида «День»: без рабочего графика колонок в дне нет, и проверка метки
    // «без номера» на карточке записи смотрела бы в пустой экран
    for (const id of ['an-m1', 'an-m2', 'an-m3']) {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        await db.query(
          `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
           VALUES ($1, $2, true, '10:00', '20:00')`,
          [id, weekday]
        );
      }
      for (const day of [daysFromToday(-7), daysFromToday(-10)]) {
        await db.query(
          `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ($1, $2, '10:00', '20:00')`,
          [id, day]
        );
      }
    }

    // id брони задаётся явно, а не автосчётчиком: проверки ниже ищут конкретные записи
    // в карточке дня, и добавление любой новой фикстуры в середину списка не должно
    // молча переименовывать чужие записи (на этом прогон один раз уже споткнулся)
    async function booking({ id, master, client = null, days, status = 'done', source = null }) {
      await db.query(
        `INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status, channel, walkin_name, client_source)
         VALUES ($1, 1, $2, $3, $4, '11:00', '12:00', $5, 'admin', $6, $7)`,
        [id, master, client, daysFromToday(-days), status, client ? null : 'QA Прохожий', source]
      );
    }

    // Пропал давно (50 дней) - именно он и есть «не вернулся»
    await booking({ id: 'an-lapsed', master: 'an-m1', client: 'an-c4', days: 50, source: 'referral' });
    await booking({ id: 'an-c1-40', master: 'an-m1', client: 'an-c1', days: 40, source: 'yandex_maps' });
    await booking({ id: 'an-withphone', master: 'an-m1', client: 'an-c1', days: 10, source: 'yandex_maps' });
    await booking({ id: 'an-c2-20', master: 'an-m1', client: 'an-c2', days: 20, source: '2gis' });
    await booking({ id: 'an-c1-5', master: 'an-m2', client: 'an-c1', days: 5, source: 'instagram' });
    await booking({ id: 'an-c3-30', master: 'an-m2', client: 'an-c3', days: 30, source: '2gis' });
    await booking({ id: 'an-c3-3', master: 'an-m2', client: 'an-c3', days: 3, source: null });
    // Отменённая запись: в возвращаемость не идёт (визита не было), в каналы идёт
    // (площадка свою работу сделала - человек записался)
    await booking({ id: 'an-cancelled', master: 'an-m1', client: 'an-c2', days: 2, status: 'cancelled', source: 'yandex_maps' });
    // Визит без телефона клиента - вне расчёта возвращаемости, отдельной оговоркой
    await booking({ id: 'an-walkin', master: 'an-m1', client: null, days: 7, source: 'walkin' });

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        await s.setViewport(1440, 1000);
        await s.navigate(`${siteUrl}/crm-owner.html`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await sleep(150);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = 'an-boss@alikhan.test';
          document.getElementById('loginPin').value = '${bossPin}';
          document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click();
        })()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!document.querySelector("#crmMain:not([hidden])")')); i++) await sleep(200);

        // До захода в раздел данные не тянутся - раздел грузится по первому открытию
        await s.eval(`document.querySelector('.app-nav-item[data-section="analytics"]')?.click()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#anRet3 .stat-card'))`)); i++) await sleep(200);
        // Карточки раздела свёрнуты по умолчанию - человек их раскрывает кликом по
        // заголовку. Раскрываем тем же кликом, а не выставлением open=true: дальше
        // проверяется настоящая кликабельность кнопки внутри, а внутри свёрнутого
        // блока «клик» через JS проходит по невидимому элементу и ничего не доказывает
        await s.eval(`document.querySelectorAll('.panel-d details.staff-card summary').forEach(el => el.click())`);
        await sleep(500);

        const ret = JSON.parse(await s.eval(`JSON.stringify({
          lead: document.querySelector('#anRet3 .stat-card--net .sc-value')?.textContent,
          leadNote: document.querySelector('#anRet3 .stat-card--net .sc-note')?.textContent,
          cards: [...document.querySelectorAll('#anRet3 .stat-cards')].pop() ? [...[...document.querySelectorAll('#anRet3 .stat-cards')].pop().querySelectorAll('.stat-card')].map(c => ({
            label: c.querySelector('.sc-label')?.textContent,
            value: c.querySelector('.sc-value')?.textContent,
            note: c.querySelector('.sc-note')?.textContent,
          })) : [],
          text: document.getElementById('anRet3')?.textContent,
          example: /пример/.test(document.getElementById('anRet3')?.textContent || ''),
        })`));

        check('возвращаемость салона - реальная цифра (2 из 3 = 67%), не «00% пример»',
          norm(ret.lead) === '67%' && !ret.example, JSON.stringify(ret.lead));
        check('под цифрой салона видна база расчёта (2 из 3)',
          norm(ret.leadNote) === '2 из 3', norm(ret.leadNote));

        const byName = Object.fromEntries(ret.cards.map((c) => [norm(c.label), c]));
        check('возвращаемость по сотрудникам: показаны все трое мастеров',
          ['QA Мастер Первый', 'QA Мастер Второй', 'QA Мастер Без Записей'].every((n) => byName[n]),
          Object.keys(byName).join(' | '));
        check('мастер 1: 1 из 2 его клиентов вернулись = 50%',
          norm(byName['QA Мастер Первый']?.value) === '50%' && norm(byName['QA Мастер Первый']?.note) === '1 из 2',
          JSON.stringify(byName['QA Мастер Первый']));
        check('мастер 2: клиент, что был у него на этой неделе, в расчёт не взят - 1 из 1 = 100%',
          norm(byName['QA Мастер Второй']?.value) === '100%' && norm(byName['QA Мастер Второй']?.note) === '1 из 1',
          JSON.stringify(byName['QA Мастер Второй']));
        check('недавний клиент показан отдельной карточкой «Пришли недавно», а не потерян',
          norm(byName['Пришли недавно']?.value) === '1' && /Ещё рано судить/.test(norm(byName['Пришли недавно']?.note)),
          JSON.stringify(byName['Пришли недавно']));
        check('мастер без визитов: прочерк и честная подпись, а не 0%',
          norm(byName['QA Мастер Без Записей']?.value) === '—' && norm(byName['QA Мастер Без Записей']?.note) === 'Нет визитов',
          JSON.stringify(byName['QA Мастер Без Записей']));
        check('визит без телефона показан карточкой-заглушкой, а не абзацем',
          norm(byName['Без телефона']?.value) === '1' && norm(byName['Без телефона']?.note) === 'Визиты, клиента не опознать',
          JSON.stringify(byName['Без телефона']));
        check('лишних абзацев-пояснений в возвращаемости не осталось (минимализм)',
          JSON.parse(await s.eval(`JSON.stringify(document.querySelectorAll('#anRet3 .payroll-note').length)`)) === 0);

        // ── Каналы привлечения ────────────────────────────────────────────
        const src = JSON.parse(await s.eval(`JSON.stringify({
          cards: [...document.querySelectorAll('#anSrc1 .stat-card')].map(c => ({
            label: c.querySelector('.sc-label')?.textContent,
            value: c.querySelector('.sc-value')?.textContent,
            note: c.querySelector('.sc-note')?.textContent,
          })),
          text: document.getElementById('anSrc1')?.textContent,
          example: /пример/.test(document.getElementById('anSrc1')?.textContent || ''),
        })`));
        const srcByName = Object.fromEntries(src.cards.map((c) => [norm(c.label), c]));
        check('каналы: «Яндекс Карты» показаны отдельной строкой с долей 2 из 7 = 29%',
          norm(srcByName['Яндекс Карты']?.value) === '29%' && /2 запис/.test(norm(srcByName['Яндекс Карты']?.note)),
          JSON.stringify(srcByName['Яндекс Карты']));
        check('каналы: «2ГИС» - 2 записи из 7 = 29%',
          norm(srcByName['2ГИС']?.value) === '29%', JSON.stringify(srcByName['2ГИС']));
        check('каналы: «Инстаграм» на месте (1 запись)',
          /1 запись/.test(norm(srcByName['Инстаграм']?.note)), JSON.stringify(srcByName['Инстаграм']));
        // Ноль записей при непустом периоде - это именно 0%, а не «нечего считать»:
        // прочерк здесь был бы враньём в другую сторону. Важно, что канал не спрятан
        check('каналы: площадка без записей за период показана строкой «0%», а не спрятана',
          norm(srcByName['Телеграм']?.value) === '0%' && norm(srcByName['Телеграм']?.note) === '0 записей',
          JSON.stringify(srcByName['Телеграм']));
        check('каналы: запись без источника - строка «Источник не указан», а не выдуманный канал',
          norm(srcByName['Источник не указан']?.note) === '1 запись', JSON.stringify(srcByName['Источник не указан']));
        check('каналы: заглушек «00% пример» в разделе не осталось', !src.example, norm(src.text).slice(0, 160));
        check('каналы: под карточками названо общее число записей периода (7), одной короткой строкой',
          norm(src.text).endsWith('Всего записей: 7'), norm(src.text).slice(-120));

        // ── Кто не вернулся: список поимённо ──────────────────────────────
        const lapsedBtnText = JSON.parse(await s.eval(`JSON.stringify(document.querySelector('#anRet3 .stat-card--net .sc-action')?.textContent)`));
        check('на карточке салона есть вход в список невернувшихся (1 клиент)',
          norm(lapsedBtnText) === '1 не вернулся', norm(lapsedBtnText));

        // Настоящий хит-тест: жмём по координатам кнопки, а не программным .click() -
        // так ловится случай, когда кнопка есть в DOM, но перекрыта или схлопнута
        const btnBox = JSON.parse(await s.eval(`(function(){
          const b = document.querySelector('#anRet3 .stat-card--net .sc-action');
          if (!b) return 'null';
          const r = b.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        })()`));
        check('кнопка «не вернулись» действительно кликабельна (не перекрыта)',
          btnBox && Number.isFinite(btnBox.x), JSON.stringify(btnBox));
        await s.clickAt(btnBox.x, btnBox.y);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#anLapsed .an-lapsed-row'))`)); i++) await sleep(150);
        const lapsed = JSON.parse(await s.eval(`JSON.stringify({
          names: [...document.querySelectorAll('#anLapsed .an-lapsed-name')].map(b => b.textContent),
          when: document.querySelector('#anLapsed .an-lapsed-when')?.textContent,
          links: document.querySelectorAll('#anLapsed [data-msg-link]').length,
        })`));
        // Не вернулся ровно один: c2 был у салона один раз (c1 и c3 приходили дважды)
        check('в списке только тот, кто пропал давно - клиента с визитом 20 дней назад в нём нет',
          lapsed.names.length === 1 && norm(lapsed.names[0]) === 'QA Клиент 4', JSON.stringify(lapsed.names));
        check('в строке клиента есть дата последнего визита и кнопки связи',
          /\d{2}\.\d{2}\.\d{4}/.test(norm(lapsed.when)) && lapsed.links > 0, JSON.stringify(lapsed));

        await s.screenshot('/tmp/analitika-lapsed.png');

        // Переход в карточку клиента - тот же раздел «Клиенты», что открыл бы человек
        await s.eval(`document.querySelector('#anLapsed .an-lapsed-name')?.click()`);
        for (let i = 0; i < 60 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.client-card[open]'))`)); i++) await sleep(200);
        const jumped = JSON.parse(await s.eval(`JSON.stringify({
          section: document.querySelector('.app-nav-item[aria-current="true"]')?.dataset.section,
          search: document.getElementById('clientsSearch')?.value,
          openCard: document.querySelector('.client-card[open]')?.textContent?.slice(0, 40),
          counter: document.getElementById('clientsCount')?.textContent,
        })`));
        check('клик по имени переводит в раздел «Клиенты» с раскрытой карточкой этого клиента',
          jumped.section === 'clients' && /QA Клиент 4/.test(norm(jumped.openCard)), JSON.stringify(jumped));
        check('в «Клиентах» виден счётчик визитов без телефона, самих таких строк в списке нет',
          /без телефона: 1/.test(norm(jumped.counter)) && !/Прохожий/.test(norm(jumped.openCard)), norm(jumped.counter));

        // Возвращаемся в аналитику для остальных проверок
        await s.eval(`document.querySelector('.app-nav-item[data-section="analytics"]')?.click()`);
        await sleep(400);

        // ── Переключение периода догружает данные ─────────────────────────
        await s.eval(`(function(){ const r = document.getElementById('rt1-12'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#anRet12 .stat-card'))`)); i++) await sleep(150);
        const year = JSON.parse(await s.eval(`JSON.stringify({
          visible: !!document.querySelector('.panel-rt1-12')?.offsetParent,
          lead: document.querySelector('#anRet12 .stat-card--net .sc-value')?.textContent,
          note: document.querySelector('#anRet12 .stat-card--net .sc-note')?.textContent,
        })`));
        check('переключение периода на «1 год» показывает свою панель с данными',
          year.visible && norm(year.lead) === '67%' && norm(year.note) === '2 из 3', JSON.stringify(year));

        // Снимки для показа владельцу - то же состояние, что проверено выше
        await sleep(400);
        await s.screenshot('/tmp/analitika-desktop.png');

        // ── Заглушка «без номера» в карточке записи ───────────────────────
        // Визит без телефона (an-walkin, 7 дней назад) - в карточке дня на его месте
        // должна стоять метка, а не пустота: пустое место читается как «не
        // подгрузилось», хотя номера у человека просто нет
        await s.eval(`document.querySelector('.app-nav-item[data-section=\"schedule\"]')?.click()`);
        // Переход к дате умеет только уже проинициализированное «Расписание»
        // (window.__openScheduleDay появляется при первом входе в раздел) - ждём его,
        // иначе прогон проверял бы пустой экран и рапортовал ложный успех
        for (let i = 0; i < 60 && !JSON.parse(await s.eval('!!window.__openScheduleDay')); i++) await sleep(200);
        await s.eval(`window.__openScheduleDay('${daysFromToday(-7)}')`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.appt[data-id=\"an-walkin\"]'))`)); i++) await sleep(200);
        const walkinCard = JSON.parse(await s.eval(`JSON.stringify({ text: document.querySelector('.appt[data-id="an-walkin"]')?.textContent })`));
        check('запись без телефона помечена «без номера», а не показана пустой строкой',
          /без номера/.test(norm(walkinCard.text)), norm(walkinCard.text));

        // Контроль: у записи С телефоном метки быть не должно - иначе «без номера»
        // стояло бы на всех подряд и ничего не означало. Запись живёт на другом дне,
        // поэтому переводим календарь туда
        await s.eval(`window.__openScheduleDay('${daysFromToday(-10)}')`);
        for (let i = 0; i < 80 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('.appt[data-id=\"an-withphone\"]'))`)); i++) await sleep(200);
        const phoneCard = JSON.parse(await s.eval(`JSON.stringify({ text: document.querySelector('.appt[data-id="an-withphone"]')?.textContent })`));
        check('записи с номером метка не приписывается',
          !!phoneCard.text && !/без номера/.test(norm(phoneCard.text)), norm(phoneCard.text).slice(0, 120));

        await s.eval(`document.querySelector('.app-nav-item[data-section="analytics"]')?.click()`);
        await sleep(400);

        // ── Мобильный стандарт ────────────────────────────────────────────
        await s.setViewport(360, 780, true);
        await sleep(400);
        const mobile = JSON.parse(await s.eval(`JSON.stringify({
          docScroll: document.documentElement.scrollWidth,
          viewport: Math.round(window.visualViewport?.width || window.innerWidth),
          cardWidths: [...document.querySelectorAll('#anRet12 .stat-card')].map(c => Math.round(c.getBoundingClientRect().width)),
        })`));
        check('360px: страница не переполнена по горизонтали',
          mobile.docScroll <= mobile.viewport + 1, JSON.stringify(mobile));
        check('360px: карточки показателей помещаются в экран',
          mobile.cardWidths.every((w) => w <= mobile.viewport), JSON.stringify(mobile.cardWidths));

        await s.setViewport(768, 900, true);
        await sleep(300);
        const tablet = JSON.parse(await s.eval(`JSON.stringify({ docScroll: document.documentElement.scrollWidth, viewport: Math.round(window.visualViewport?.width || window.innerWidth) })`));
        check('768px: страница не переполнена по горизонтали', tablet.docScroll <= tablet.viewport + 1, JSON.stringify(tablet));

        await s.setViewport(360, 1400, true);
        await sleep(300);
        await s.screenshot('/tmp/analitika-mobile.png');
      });
    });
  });
} catch (e) {
  crashed = true;
  console.log('CRASH', e?.stack || e);
}

const ok = summary() && !crashed;
process.exit(ok ? 0 : 1);
