// Живая проверка двух жалоб Влада 16.08.2026:
//  1) "Данные сохранены, а роль не изменилась: Такой роли не существует" при
//     сохранении карточки, где роль показана бейджем (владелец);
//  2) "кнопка Принимает клиентов ... при изменении не меняется - не выдаёт
//     сохранено" - следствие первой: шаг роли обрывал сохранение до подтверждения и
//     до перезагрузки, которая перестраивает расписание.
//
// Проверяем настоящим кликом по тумблеру и настоящей кнопкой "Сохранить изменения",
// а результат сверяем в БАЗЕ, а не по экрану. Плюс регресс: смена роли у обычного
// мастера (там радиокнопки настоящие) по-прежнему работает.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, hashPin, randomPin } from './verify-lib.mjs';

const { check, summary } = makeChecker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let crashed = false;
try {
  await withEphemeralServer(async ({ apiUrl, db }) => {
    const ownerPin = randomPin();
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vr-owner', 1, 'QA Владелец', 'owner', true, false, true, 'vr-owner@alikhan.test', $1)`,
      [hashPin(ownerPin)]
    );
    // Второй владелец, который ПРИНИМАЕТ клиентов - ровно карточка из жалобы: роль
    // owner показывается бейджем, тумблер "Принимает клиентов" включён
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vr-owner2', 1, 'QA Владелец Второй', 'owner', true, true, true, 'vr-owner2@alikhan.test', $1)`,
      [hashPin(randomPin())]
    );
    await db.query(
      `INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
       VALUES ('vr-master', 1, 'QA Мастер', 'master', true, true, true, 'vr-master@alikhan.test', $1)`,
      [hashPin(randomPin())]
    );

    await withStaticServer(apiUrl, async (siteUrl) => {
      await withBrowser(async (s) => {
        const login = async () => {
          await s.navigate(`${siteUrl}/crm-owner.html`);
          for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.getElementById('loginEmail'))`)); i++) await sleep(150);
          await s.eval(
            `document.getElementById('loginEmail').value = 'vr-owner@alikhan.test';
             document.getElementById('loginPin').value = '${ownerPin}';
             document.querySelector('#loginForm button[type=submit], #loginSubmit')?.click()`
          );
          await sleep(3000);
        };
        const openCard = async (staffId) =>
          await s.eval(
            `(() => {
               const card = document.querySelector('.team-editor-card[data-staff-id="${staffId}"]');
               if (!card) return null;
               card.open = true;
               return { role: card.dataset.role, provides: card.dataset.providesServices };
             })()`
          );
        const cardNote = async (staffId) =>
          await s.eval(
            `document.querySelector('.team-editor-card[data-staff-id="${staffId}"] [data-card-note]')?.textContent?.trim() ?? ''`
          );

        await login();

        // ── 1. Карточка владельца: тумблер "Принимает клиентов" + Сохранить
        const opened = await openCard('vr-owner2');
        check('карточка второго владельца открыта, роль на ней помечена', opened?.role === 'owner', JSON.stringify(opened));

        const badgeValue = await s.eval(
          `(() => {
             const card = document.querySelector('.team-editor-card[data-staff-id="vr-owner2"]');
             const any = card?.querySelector('.team-role-picker input[type=radio]:checked');
             const editable = card?.querySelector('.team-role-picker input[type=radio]:checked:not([disabled])');
             return { anyValue: any?.value ?? null, editable: Boolean(editable) };
           })()`
        );
        // Это и есть корень бага: у бейджа .value === 'on', и раньше именно оно уезжало
        check('радиокнопка-бейдж по-прежнему отдаёт "on", но берётся уже не она',
          badgeValue?.anyValue === 'on' && badgeValue?.editable === false, JSON.stringify(badgeValue));

        await s.eval(
          `(() => {
             const card = document.querySelector('.team-editor-card[data-staff-id="vr-owner2"]');
             const toggle = card.querySelector('[name="providesServices"]');
             toggle.checked = !toggle.checked;
             toggle.dispatchEvent(new Event('change', { bubbles: true }));
           })()`
        );
        await sleep(400);
        const saveEnabled = await s.eval(
          `!document.querySelector('.team-editor-card[data-staff-id="vr-owner2"] [data-save]')?.disabled`
        );
        check('переключение "Принимает клиентов" будит кнопку сохранения', saveEnabled === true, `enabled=${saveEnabled}`);

        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="vr-owner2"] [data-save]')?.click()`);
        await sleep(2500);

        const note = await cardNote('vr-owner2');
        // Страница после смены этого флага перезагружается сама - подпись успеваем
        // прочитать не всегда, поэтому главная улика ниже, в базе
        check('в карточке нет ошибки про роль',
          !/роль не изменилась|Такой роли не существует/i.test(note), `подпись: "${note}"`);

        const saved = (await db.query(`SELECT provides_services, role FROM staff WHERE id = 'vr-owner2'`)).rows[0];
        check('"Принимает клиентов" сохранился в базе (был включён - стал выключен)',
          saved.provides_services === false, `provides_services=${saved.provides_services}`);
        check('роль владельца при этом не пострадала', saved.role === 'owner', `role=${saved.role}`);

        // ── 2. Регресс: у обычного мастера роль по-прежнему меняется
        await sleep(2500); // страница сама перезагрузилась после смены флага
        for (let i = 0; i < 40 && !(await s.eval(`Boolean(document.querySelector('.team-editor-card'))`)); i++) await sleep(200);
        await openCard('vr-master');
        const switched = await s.eval(
          `(() => {
             const card = document.querySelector('.team-editor-card[data-staff-id="vr-master"]');
             const admin = [...card.querySelectorAll('.team-role-picker input[type=radio]')].find((n) => n.value === 'admin');
             if (!admin) return false;
             admin.checked = true;
             admin.dispatchEvent(new Event('change', { bubbles: true }));
             return true;
           })()`
        );
        check('у мастера радиокнопки роли настоящие (есть вариант "admin")', switched === true);
        await s.eval(`document.querySelector('.team-editor-card[data-staff-id="vr-master"] [data-save]')?.click()`);
        await sleep(2500);

        const masterRow = (await db.query(`SELECT role FROM staff WHERE id = 'vr-master'`)).rows[0];
        check('смена роли мастер → администратор сохранилась', masterRow.role === 'admin', `role=${masterRow.role}`);
        // Подпись в самой карточке живёт до перерисовки списка (renderTeam), поэтому
        // подтверждение ищем там, где человек его и видит - во всплывающем окне внизу
        // экрана: успех гаснет сам, ошибка висит до закрытия (assets/crm-toast.js)
        const toasts = await s.eval(
          `[...document.querySelectorAll('.crm-toast')].map((t) => ({ type: t.dataset.type, text: t.dataset.message }))`
        );
        const ok = (toasts || []).some((t) => t.type === 'success' && /Сохранено/i.test(t.text));
        const err = (toasts || []).some((t) => t.type === 'error');
        check('после смены роли на экране зелёное "Сохранено" и ни одной ошибки',
          ok && !err, JSON.stringify(toasts));
      });
    });
  });
} catch (err) {
  crashed = true;
  console.error('ПРОГОН УПАЛ:', err.message);
}

summary();
if (crashed) process.exit(1);
