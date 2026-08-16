// Живая проверка правки 16.08.2026: раздел «Сотрудники» у администратора перестал
// быть статичным макетом и рисуется общим renderTeam из GET /staff.
//
// Что доказываем на эфемерной базе (свой Postgres + свой server.mjs + свой статик):
//   1. администратор видит РЕАЛЬНЫЙ состав команды, включая сотрудника, которого в
//      старой вёрстке не было физически (её три карточки были написаны руками)
//   2. в разделе нет ни одного элемента управления, на который сервер ответит ему
//      отказом: нет «Добавить сотрудника», нет загрузки фото, поля состава закрыты
//   3. график остаётся рабочим - это его прямая обязанность (сервер пускает admin в
//      PUT /master-weekly-schedule), и сохранение недели реально доезжает до базы
//   4. владелец на той же странице «Команда» ничего не потерял - поля открыты,
//      кнопка называется по-прежнему, карточка добавления на месте
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();

const OWNER = { id: 'qa-1608-owner', role: 'owner', name: 'QA Владелец' };
const ADMIN = { id: 'qa-1608-admin', role: 'admin', name: 'QA Администратор' };
const MASTER = { id: 'qa-1608-master', role: 'master', name: 'QA Мастер Поздний' };

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const pins = new Map();
  for (const acc of [OWNER, ADMIN, MASTER]) {
    const pin = randomPin();
    pins.set(acc.id, pin);
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ($1, 1, $2, $3, true, $4, true, $5, $6)`,
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
  console.log('фикстуры: владелец, администратор и «поздний» мастер, которого нет ни в одной статичной карточке\n');

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      const login = async (acc, page) => {
        await s.navigate(`${siteUrl}/${page}`);
        await s.setViewport(1440, 1800, false);
        for (let i = 0; i < 60; i++) {
          if (await s.eval('!!document.getElementById("loginEmail")')) break;
          await s.sleep(150);
        }
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = ${JSON.stringify(`${acc.id}@alikhan.test`)};
          document.getElementById('loginPin').value = ${JSON.stringify(pins.get(acc.id))};
          document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
        })()`);
        for (let i = 0; i < 60; i++) {
          if (await s.eval('!document.getElementById("crmMain").hidden')) break;
          await s.sleep(250);
        }
        await s.sleep(2500);
      };
      const openTeam = async () => {
        await s.eval(`(function(){ const b=document.querySelector('.app-nav-item[data-section="team"]'); if(b) b.click(); })()`);
        await s.sleep(1500);
        for (let i = 0; i < 40; i++) {
          if (await s.eval(`document.querySelectorAll('.panel-b .staff-list .team-editor-card').length > 0`)) break;
          await s.sleep(250);
        }
        await s.eval(`(function(){ document.querySelectorAll('.panel-b .staff-list details').forEach(d => d.setAttribute('open','')); })()`);
        await s.sleep(1500);
      };

      // ── Администратор ───────────────────────────────────────────────────
      await login(ADMIN, 'crm-admin.html');
      await openTeam();

      const names = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('.panel-b .staff-list .team-editor-card .summary-meta .name')].map(e => e.textContent.trim()))`));
      // Базовый сид миграций (Алиовсад/Мамедхан/Елизавета) плюс три фикстуры прогона:
      // важно не «сколько», а что список идёт из ответа сервера и содержит всех
      check('администратор видит весь реальный состав из GET /staff', [OWNER, ADMIN, MASTER].every((a) => names.includes(a.name)) && names.length >= 6, `увидел: ${JSON.stringify(names)}`);
      check('в списке есть сотрудник, которого не было в старом макете', names.includes(MASTER.name), JSON.stringify(names));
      check('роли подписаны текущими значениями, без «Администратор + Мастер»', !(await s.eval(`document.body.innerText.includes('Администратор + Мастер')`)));
      check('исчезли макетные бейджи «пример»', !(await s.eval(`document.body.innerText.toLowerCase().includes('пример')`)));
      check('исчезла выдуманная аналитика «00%»', !(await s.eval(`document.querySelector('.panel-b').innerText.includes('00%')`)));
      check('исчезло техническое staff.provides_services на экране', !(await s.eval(`document.body.innerText.includes('provides_services')`)));

      check('нет карточки «Добавить сотрудника»', await s.eval(`!document.querySelector('.panel-b .team-add-card')`));
      check('нет загрузки фото и портфолио', await s.eval(`document.querySelectorAll('.panel-b input[type="file"]').length === 0`));
      check('поля состава закрыты для правки', await s.eval(`[...document.querySelectorAll('.panel-b [name="name"], .panel-b [name="phone"], .panel-b [name="email"]')].every(i => i.disabled)`));
      check('тумблеры состава закрыты для правки', await s.eval(`[...document.querySelectorAll('.panel-b [name="employed"], .panel-b [name="providesServices"]')].every(i => i.disabled)`));
      check('чекбоксы услуг закрыты для правки', await s.eval(`[...document.querySelectorAll('.panel-b .service-check input[type="checkbox"]')].every(i => i.disabled)`));
      check('роль показана бейджем, а не выбором', await s.eval(`document.querySelectorAll('.panel-b .team-role-picker:not(.team-role-picker-single)').length === 0`));
      check('кнопка сохранения названа по своему праву - «Сохранить график»', await s.eval(`[...document.querySelectorAll('.panel-b [data-save]')].every(b => b.textContent.trim() === 'Сохранить график' && b.hasAttribute('data-schedule-only'))`));

      // График - его работа: меняем рабочую неделю мастера и сохраняем
      const masterCardSelector = `.panel-b .team-editor-card[data-staff-id="${MASTER.id}"]`;
      const weeklyInputs = await s.eval(`document.querySelectorAll('${masterCardSelector} #weeklyEditor-${MASTER.id} input:not([disabled])').length`);
      check('поля рабочей недели остались открытыми администратору', weeklyInputs > 0, `открытых полей: ${weeklyInputs}`);

      // Меняем понедельник на выходной - тумблер рабочего дня в редакторе недели
      // (время задаётся темизированным виджетом, а не нативным input, поэтому
      // самый честный «клик человека» здесь именно по переключателю дня)
      const changed = await s.eval(`(function(){
        const toggle = document.getElementById('weekly-${MASTER.id}-1-working');
        if (!toggle) return 'НЕТ ПЕРЕКЛЮЧАТЕЛЯ ДНЯ';
        toggle.click();
        return toggle.checked ? 'ВКЛЮЧИЛСЯ' : 'OK';
      })()`);
      check('переключатель рабочего дня в редакторе недели откликается', changed === 'OK', String(changed));

      await s.sleep(800);
      const saveEnabled = await s.eval(`(function(){ const b=document.querySelector('${masterCardSelector} [data-save]'); return b ? !b.disabled : false; })()`);
      check('правка недели будит кнопку сохранения', saveEnabled);

      if (saveEnabled) {
        await s.eval(`document.querySelector('${masterCardSelector} [data-save]').click()`);
        await s.sleep(3000);
        const stored = await db.query('SELECT is_working FROM master_weekly_schedule WHERE master_id = $1 AND weekday = 1', [MASTER.id]);
        check('сохранённая администратором неделя доехала до базы', stored.rows[0]?.is_working === false, `в базе is_working: ${stored.rows[0]?.is_working}`);
        // Подпись в самой карточке живёт до перерисовки (renderTeam сразу после
        // сохранения рисует карточки заново - так же и у владельца), поэтому
        // подтверждение ловим там, где его видит человек: во всплывающем окне
        const toasts = JSON.parse(await s.eval(`JSON.stringify([...document.querySelectorAll('.crm-toast')].map(t => (t.className + '::' + (t.querySelector('.crm-toast__text')||{}).textContent)))`));
        check('интерфейс подтвердил сохранение, а не показал отказ', toasts.some((t) => /сохран/i.test(t)) && !toasts.some((t) => /crm-toast--error/.test(t)), `окна: ${JSON.stringify(toasts)}`);
      }

      const failedCalls = JSON.parse(await s.eval(`JSON.stringify(window.__adminFailedCalls || [])`));
      check('на экране администратора не осталось запросов с отказом', failedCalls.length === 0, JSON.stringify(failedCalls));

      // ── Владелец: ничего не потерял ─────────────────────────────────────
      await login(OWNER, 'crm-owner.html');
      await openTeam();
      check('владелец по-прежнему видит карточку добавления сотрудника', await s.eval(`!!document.querySelector('.panel-b .team-add-card')`));
      check('владельцу поля состава открыты', await s.eval(`[...document.querySelectorAll('.panel-b .team-editor-card [name="name"]')].some(i => !i.disabled)`));
      check('у владельца кнопка сохраняет карточку целиком', await s.eval(`[...document.querySelectorAll('.panel-b [data-save]')].every(b => b.textContent.trim() === 'Сохранить изменения' && !b.hasAttribute('data-schedule-only'))`));
      check('владельцу доступна загрузка фото', await s.eval(`document.querySelectorAll('.panel-b input[type="file"]').length > 0`));
    });
  });
});
} catch (err) {
  crashed = true;
  console.error('\nПРОГОН УПАЛ:', err.message);
}

const ok = summary();
process.exit(ok && !crashed ? 0 : 1);
