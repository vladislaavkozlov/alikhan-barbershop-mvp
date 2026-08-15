// Живая проверка правки Влада от 15.08.2026: «почему при входе в кабинет возникают
// ошибки?». На экране висели две красные плашки - «Не удалось загрузить рабочую
// неделю: Сессия закончилась. Войдите заново» и то же про разовые изменения.
//
// Причина (воспроизведена живьём на проде до правки): кабинет владельца запускал
// отрисовку «Команды» сразу при загрузке страницы, ДО того как закончилась проверка
// сохранённой сессии. Успевали пройти /staff, /services, /locations - карточки
// начинали грузить график мастеров, и в этот момент проверка решала, что сессия для
// этой страницы не годится (истекла или это сессия другой роли), и стирала токен.
// Запросы второй волны уходили уже без токена и возвращались с 401.
//
// Проверяется на эфемерной базе, все три случая входа:
//   A. чистый вход владельца - кабинет открылся, «Команда» отрисована, отказов нет
//   B. открыть кабинет владельца, имея живую сессию МАСТЕРА - форма входа, отказов нет
//   C. то же с испорченным (несуществующим) токеном - форма входа, отказов нет
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();

const OWNER = { id: 'qa-vhod-owner', role: 'owner', name: 'QA Вход Владелец' };
const MASTER = { id: 'qa-vhod-master', role: 'master', name: 'QA Вход Мастер' };

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
  // Рабочая неделя мастеру - чтобы карточка «Команды» реально пошла за графиком
  // (именно этот запрос и падал у Влада), а не пропустила его за ненадобностью
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    await db.query(
      `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
       VALUES ($1, $2, true, '10:00', '20:00')`,
      [MASTER.id, weekday]
    );
  }
  console.log('фикстуры: владелец + мастер с рабочей неделей 10:00-20:00');

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      const open = async (page) => {
        await s.navigate(`${siteUrl}/${page}`);
        await s.setViewport(1280, 1400, false);
        for (let i = 0; i < 40 && !JSON.parse(await s.eval('!!document.getElementById("loginEmail")')); i++) await s.sleep(150);
      };
      const login = async (acc, page) => {
        await open(page);
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = ${JSON.stringify(`${acc.id}@alikhan.test`)};
          document.getElementById('loginPin').value = ${JSON.stringify(pins.get(acc.id))};
          document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
        })()`);
        await s.sleep(2500);
        await s.setViewport(1280, 1400, false);
        await s.sleep(300);
      };
      // Ждём, пока страница успокоится: и первая волна запросов, и та, что уходит
      // после проверки сессии - иначе можно снять экран раньше отказа
      const settle = async () => { await s.sleep(6000); };
      const state = async () => JSON.parse(await s.eval(`JSON.stringify({
        errors: [...document.querySelectorAll('.crm-toast--error .crm-toast__text')].map(n => n.textContent),
        gateVisible: !document.getElementById('loginGate')?.hidden,
        mainVisible: !document.getElementById('crmMain')?.hidden,
        teamCards: document.querySelectorAll('.panel-b .staff-list .team-editor-card').length,
        weeklyLoaded: document.querySelectorAll('.panel-b .weekly-panels, .panel-b .breaks-list').length,
        token: (localStorage.getItem('alikhan-crm:token') || 'нет').slice(0, 8),
      })`));

      // ── A. чистый вход владельца ───────────────────────────────────────
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await s.eval('localStorage.clear()');
      await login(OWNER, 'crm-owner.html');
      await settle();
      const a = await state();
      console.log('A:', JSON.stringify(a));
      check('A. владелец вошёл - кабинет открыт', a.mainVisible && !a.gateVisible);
      check('A. «Команда» отрисована после входа', a.teamCards >= 2, `карточек ${a.teamCards}`);
      check('A. график мастеров загрузился', a.weeklyLoaded >= 1, `блоков ${a.weeklyLoaded}`);
      check('A. ни одного сообщения об отказе', a.errors.length === 0, a.errors.join(' | '));

      // ── B. кабинет владельца с живой сессией мастера ───────────────────
      await login(MASTER, 'crm-master.html');
      const masterRole = await s.eval(`(JSON.parse(localStorage.getItem('alikhan-crm:staff')||'{}').role || 'нет')`);
      check('B. сессия мастера действительно создана', masterRole === 'master', `роль ${masterRole}`);
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await settle();
      const b = await state();
      console.log('B:', JSON.stringify(b));
      check('B. чужая роль уводит на форму входа', b.gateVisible && !b.mainVisible);
      check('B. ни одного сообщения об отказе', b.errors.length === 0, b.errors.join(' | '));

      // ── C. кабинет владельца с испорченным токеном ─────────────────────
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await s.eval(`(function(){
        localStorage.setItem('alikhan-crm:token', 'ffffffffffffffffffffffffffffffff');
        localStorage.setItem('alikhan-crm:staff', JSON.stringify({ id: 'qa-vhod-owner', name: 'QA Вход Владелец', role: 'owner' }));
      })()`);
      await s.navigate(`${siteUrl}/crm-owner.html`);
      await settle();
      const c = await state();
      console.log('C:', JSON.stringify(c));
      check('C. просроченная сессия уводит на форму входа', c.gateVisible && !c.mainVisible);
      check('C. ни одного сообщения об отказе', c.errors.length === 0, c.errors.join(' | '));

      // ── D. сообщения не сломаны: после нового входа отказ виден ────────
      await login(OWNER, 'crm-owner.html');
      await settle();
      await s.eval(`(async function(){
        const card = document.querySelector('.panel-b .team-editor-card[data-staff-id="${MASTER.id}"]');
        if (card) card.setAttribute('open', '');
      })()`);
      const mod = await s.eval(`(async function(){
        const { showError } = await import('./assets/crm-toast.js');
        showError('Проверка: сообщения работают');
        return document.querySelectorAll('.crm-toast--error').length;
      })()`, true);
      check('D. после нормального входа сообщения об ошибке снова показываются', mod >= 1, `тостов ${mod}`);
    });
  });
});
} catch (error) {
  crashed = true;
  console.error('Прогон упал:', error);
}

const ok = summary() && !crashed;
process.exit(ok ? 0 : 1);
