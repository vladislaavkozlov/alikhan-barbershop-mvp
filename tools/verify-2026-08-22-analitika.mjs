// Живой прогон раздела «Аналитика» владельца (22.08.2026, задача Влада:
// «возвращаемость клиентов по сотрудникам» и «в „Как приходят клиенты“ добавить
// откуда - яндекс, 2гис и т.д.»).
//
// Проверяем на эфемерной базе с заведомо известными цифрами: сеем брони так, чтобы
// правильный ответ был посчитан руками заранее, и сверяем то, что человек реально
// видит на экране, а не то, что вернул JSON.
//
// Раскладка фикстуры (все визиты - в пределах последних 3 месяцев, status='done'):
//   мастер m1: клиент c1 (2 визита), клиент c2 (1 визит)  → 1 из 2 = 50%
//   мастер m2: клиент c1 (1 визит),  клиент c3 (2 визита) → 1 из 2 = 50%
//   мастер m3: визитов нет                                 → прочерк, не 0%
//   салон: c1 (3 визита), c2 (1), c3 (2) → вернулись 2 из 3 = 67%
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
    for (const [id, name] of [['an-c1', 'QA Клиент 1'], ['an-c2', 'QA Клиент 2'], ['an-c3', 'QA Клиент 3']]) {
      await db.query('INSERT INTO clients (id, name, phone) VALUES ($1, $2, $3)', [id, name, `+7999000${id.slice(-1)}111`]);
    }

    let seq = 0;
    async function booking({ master, client = null, days, status = 'done', source = null }) {
      seq += 1;
      await db.query(
        `INSERT INTO bookings (id, location_id, master_id, client_id, date, start_time, end_time, status, channel, walkin_name, client_source)
         VALUES ($1, 1, $2, $3, $4, '11:00', '12:00', $5, 'admin', $6, $7)`,
        [`an-b${seq}`, master, client, daysFromToday(-days), status, client ? null : 'QA Прохожий', source]
      );
    }

    await booking({ master: 'an-m1', client: 'an-c1', days: 40, source: 'yandex_maps' });
    await booking({ master: 'an-m1', client: 'an-c1', days: 10, source: 'yandex_maps' });
    await booking({ master: 'an-m1', client: 'an-c2', days: 20, source: '2gis' });
    await booking({ master: 'an-m2', client: 'an-c1', days: 5, source: 'instagram' });
    await booking({ master: 'an-m2', client: 'an-c3', days: 30, source: '2gis' });
    await booking({ master: 'an-m2', client: 'an-c3', days: 3, source: null });
    // Отменённая запись: в возвращаемость не идёт (визита не было), в каналы идёт
    // (площадка свою работу сделала - человек записался)
    await booking({ master: 'an-m1', client: 'an-c2', days: 2, status: 'cancelled', source: 'yandex_maps' });
    // Визит без телефона клиента - вне расчёта возвращаемости, отдельной оговоркой
    await booking({ master: 'an-m1', client: null, days: 7, source: 'walkin' });

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
        check('под цифрой салона видна база расчёта (2 из 3 клиентов)',
          /2 из 3/.test(norm(ret.leadNote)), norm(ret.leadNote));

        const byName = Object.fromEntries(ret.cards.map((c) => [norm(c.label), c]));
        check('возвращаемость по сотрудникам: показаны все трое мастеров',
          ['QA Мастер Первый', 'QA Мастер Второй', 'QA Мастер Без Записей'].every((n) => byName[n]),
          Object.keys(byName).join(' | '));
        check('мастер 1: 1 из 2 его клиентов вернулись = 50%',
          norm(byName['QA Мастер Первый']?.value) === '50%' && /1 из 2/.test(norm(byName['QA Мастер Первый']?.note)),
          JSON.stringify(byName['QA Мастер Первый']));
        check('мастер 2: 1 из 2 его клиентов вернулись = 50%',
          norm(byName['QA Мастер Второй']?.value) === '50%', JSON.stringify(byName['QA Мастер Второй']));
        check('мастер без визитов: прочерк и честная подпись, а не 0%',
          norm(byName['QA Мастер Без Записей']?.value) === '—' && /Нет состоявшихся визитов/.test(norm(byName['QA Мастер Без Записей']?.note)),
          JSON.stringify(byName['QA Мастер Без Записей']));
        check('визит без телефона клиента не молчит - о нём сказано отдельной строкой',
          /Не учтено 1 визит/.test(norm(ret.text)), norm(ret.text).slice(-200));

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
        check('каналы: под карточками названо общее число записей периода (7)',
          /Всего записей за месяц: 7/.test(norm(src.text)), norm(src.text).slice(-260));

        // ── Переключение периода догружает данные ─────────────────────────
        await s.eval(`(function(){ const r = document.getElementById('rt1-12'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval(`JSON.stringify(!!document.querySelector('#anRet12 .stat-card'))`)); i++) await sleep(150);
        const year = JSON.parse(await s.eval(`JSON.stringify({
          visible: !!document.querySelector('.panel-rt1-12')?.offsetParent,
          lead: document.querySelector('#anRet12 .stat-card--net .sc-value')?.textContent,
          note: document.querySelector('#anRet12 .stat-card--net .sc-note')?.textContent,
        })`));
        check('переключение периода на «1 год» показывает свою панель с данными',
          year.visible && norm(year.lead) === '67%' && /за год/.test(norm(year.note)), JSON.stringify(year));

        // Снимки для показа владельцу - то же состояние, что проверено выше
        await s.eval(`document.querySelectorAll('.panel-d details.staff-card').forEach(d => d.open = true)`);
        await sleep(400);
        await s.screenshot('/tmp/analitika-desktop.png');

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
