// Живая проверка блока «Вход в CRM» (смена своего PIN), добавленного 16.08.2026 в
// «Личные данные» мастера и администратора.
//
// Сценарий на эфемерной базе, оба кабинета:
//   1. сотрудник заведён с must_change_pin = true (так его создаёт POST /staff) -
//      в разделе видна подсказка про временный PIN
//   2. короткий PIN и несовпадающий повтор отбиваются на экране, запрос не уходит
//   3. правильная смена: поля очищаются, приходит подтверждение, подсказка исчезает
//   4. в базе новый хэш и must_change_pin = false
//   5. старый PIN больше не пускает, новый пускает - проверено настоящим логином
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();

const CASES = [
  { id: 'qa-pin-master', role: 'master', name: 'QA Мастер PIN', page: 'crm-master.html' },
  { id: 'qa-pin-admin', role: 'admin', name: 'QA Админ PIN', page: 'crm-admin.html' },
];

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  const oldPins = new Map();
  for (const acc of CASES) {
    const pin = randomPin();
    oldPins.set(acc.id, pin);
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash, must_change_pin)
       VALUES ($1, 1, $2, $3, true, $4, true, $5, $6, true)`,
      [acc.id, acc.name, acc.role, acc.role === 'master', `${acc.id}@alikhan.test`, hashPin(pin), ]
    );
  }

  const login = async (email, pin) => {
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pin }),
    });
    return res.status;
  };

  await withStaticServer(apiUrl, async (siteUrl) => {
    await withBrowser(async (s) => {
      for (const acc of CASES) {
        console.log(`\n── ${acc.name} (${acc.page}) ──`);
        const newPin = String(100000 + Math.floor(Math.random() * 900000));

        await s.navigate(`${siteUrl}/${acc.page}`);
        await s.setViewport(1440, 1800, false);
        for (let i = 0; i < 60; i++) {
          if (await s.eval('!!document.getElementById("loginEmail")')) break;
          await s.sleep(150);
        }
        await s.eval(`(function(){
          document.getElementById('loginEmail').value = ${JSON.stringify(`${acc.id}@alikhan.test`)};
          document.getElementById('loginPin').value = ${JSON.stringify(oldPins.get(acc.id))};
          document.getElementById('loginForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
        })()`);
        for (let i = 0; i < 60; i++) {
          if (await s.eval('!document.getElementById("crmMain").hidden')) break;
          await s.sleep(250);
        }
        await s.sleep(2500);
        await s.eval(`(function(){ const b=document.querySelector('.app-nav-item[data-section="profile"]'); if(b) b.click(); })()`);
        await s.sleep(1500);
        await s.eval(`(function(){ document.querySelectorAll('.panel-c details').forEach(d => d.setAttribute('open','')); })()`);
        await s.sleep(1000);

        check(`${acc.role}: блок смены PIN виден в «Личных данных»`, await s.eval(`(function(){ const e=document.getElementById('pinSaveBtn'); return !!e && e.offsetParent !== null; })()`));
        check(`${acc.role}: подсказка про временный PIN показана`, await s.eval(`(function(){ const e=document.getElementById('pinMustChange'); return !!e && !e.hidden; })()`));

        // короткий PIN - отбой на экране
        await s.eval(`(function(){
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const a = document.getElementById('pinNew'); const b = document.getElementById('pinRepeat');
          set.call(a, '123'); a.dispatchEvent(new Event('input', {bubbles:true}));
          set.call(b, '123'); b.dispatchEvent(new Event('input', {bubbles:true}));
          document.getElementById('pinSaveBtn').click();
        })()`);
        await s.sleep(900);
        check(`${acc.role}: короткий PIN отбит понятным текстом`, /цифр/i.test(await s.eval(`(document.getElementById('pinNote')||{}).textContent || ''`)));

        // несовпадающий повтор
        await s.eval(`(function(){
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const a = document.getElementById('pinNew'); const b = document.getElementById('pinRepeat');
          set.call(a, '123456'); a.dispatchEvent(new Event('input', {bubbles:true}));
          set.call(b, '654321'); b.dispatchEvent(new Event('input', {bubbles:true}));
          document.getElementById('pinSaveBtn').click();
        })()`);
        await s.sleep(900);
        check(`${acc.role}: несовпадение повтора отбито`, /не совпал/i.test(await s.eval(`(document.getElementById('pinNote')||{}).textContent || ''`)));

        const hashBefore = (await db.query('SELECT pin_hash FROM staff WHERE id = $1', [acc.id])).rows[0].pin_hash;

        // настоящая смена
        await s.eval(`(function(){
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const a = document.getElementById('pinNew'); const b = document.getElementById('pinRepeat');
          set.call(a, ${JSON.stringify(newPin)}); a.dispatchEvent(new Event('input', {bubbles:true}));
          set.call(b, ${JSON.stringify(newPin)}); b.dispatchEvent(new Event('input', {bubbles:true}));
          document.getElementById('pinSaveBtn').click();
        })()`);
        await s.sleep(2500);

        check(`${acc.role}: интерфейс подтвердил смену`, /измен/i.test(await s.eval(`(document.getElementById('pinNote')||{}).textContent || ''`)));
        check(`${acc.role}: введённый PIN стёрт с экрана`, await s.eval(`document.getElementById('pinNew').value === '' && document.getElementById('pinRepeat').value === ''`));
        check(`${acc.role}: подсказка про временный PIN убралась`, await s.eval(`document.getElementById('pinMustChange').hidden === true`));

        const row = (await db.query('SELECT pin_hash, must_change_pin FROM staff WHERE id = $1', [acc.id])).rows[0];
        check(`${acc.role}: в базе новый хэш PIN`, row.pin_hash !== hashBefore);
        check(`${acc.role}: снят флаг «нужно сменить PIN»`, row.must_change_pin === false);

        check(`${acc.role}: старый PIN больше не пускает`, (await login(`${acc.id}@alikhan.test`, oldPins.get(acc.id))) === 401);
        check(`${acc.role}: новый PIN пускает`, (await login(`${acc.id}@alikhan.test`, newPin)) === 200);
      }
    });
  });
});
} catch (err) {
  crashed = true;
  console.error('\nПРОГОН УПАЛ:', err.message);
}

const ok = summary();
process.exit(ok && !crashed ? 0 : 1);
