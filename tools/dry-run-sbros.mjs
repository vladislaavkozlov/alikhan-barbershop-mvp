// Сухой прогон сброса рабочих данных (27.08.2026): что именно исчезнет и кому будет
// записан новый график.
//
// Что он делает с боевым контуром честно и полностью. Ни одной строки данных салона
// не меняет: записи, клиенты, уведомления, график и настройки только читаются
// GET-запросами. Один изменяющий запрос всё же есть - POST /auth/login: часть цифр
// (состав команды, клиенты, уведомления) без токена не видна вовсе. Он создаёт одну
// строку в sessions, то есть обычный вход владельца в свой кабинет, и в сам сброс
// таблица sessions не входит по ТЗ.
//
// Зачем отдельным шагом. Сброс запускается переменной в панели плюс перезапуском, и
// после перезапуска обсуждать уже нечего. Этот прогон показывает владельцу цифры до
// того, как он что-то нажмёт: столько записей, столько клиентов, вот полный состав
// команды с ролями и почтами - в том числе тестовые учётки, решение по которым в эту
// задачу не входит и принимается отдельно.
//
// PIN в коде не лежит и дефолта не имеет: репозиторий origin публичен, а PIN - это
// ключ от боевого кабинета владельца. Берётся из переменной окружения на время
// запуска.
//
// Запуск:
//   OWNER_EMAIL=... OWNER_PIN=... node tools/dry-run-sbros.mjs
import { RESET_SCHEDULE, RESET_TABLES } from '../api/lib/reset-tenant-data.js';

const API = process.env.API_URL ?? 'https://alikhancrm1-vladislaavkozlov.amvera.io';
const ORIGIN = process.env.ORIGIN ?? 'https://vladislaavkozlov.github.io';
const EMAIL = process.env.OWNER_EMAIL;
const PIN = process.env.OWNER_PIN;
if (!EMAIL || !PIN) {
  console.error('Нужны OWNER_EMAIL и OWNER_PIN живой учётной записи владельца: без токена API не отдаёт ни состав команды, ни клиентов, ни уведомления');
  console.error('В коде их дефолта нет сознательно - репозиторий публичен, а PIN это ключ от боевого кабинета');
  console.error('Запуск: OWNER_EMAIL=pochta@primer.test OWNER_PIN=0000 node tools/dry-run-sbros.mjs');
  process.exit(2);
}

const get = (path, token) =>
  fetch(`${API}/${path}`, {
    headers: { Origin: ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });

async function json(path, token) {
  const res = await get(path, token);
  if (!res.ok) throw new Error(`GET /${path} ответил ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const line = (title) => console.log(`\n${title}`);
// Роуты отвечают то массивом, то объектом со списком внутри - берём и то, и другое
const asList = (body) => (Array.isArray(body) ? body : body?.clients ?? body?.notifications ?? body?.items ?? []);

const health = await json('health');
const appearance = await json('tenant/appearance');
console.log('Сухой прогон сброса рабочих данных. Ни одной строки данных салона не меняется');
console.log('Единственный изменяющий запрос за весь прогон - вход владельца POST /auth/login: он создаёт одну строку в sessions и нужен, чтобы увидеть состав команды и клиентов');
console.log(`API: ${API}, источник запросов: ${ORIGIN}`);
console.log(`Арендатор по этому источнику: «${appearance.name ?? '(имя не отдано)'}», вертикаль ${appearance.vertical}`);
console.log(`Приложение живо: ok=${health.ok}, замок арендатора держит (dbRoleSafe)=${health.dbRoleSafe}, старт контейнера ${health.startedAt}`);

const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
  body: JSON.stringify({ email: EMAIL, pin: PIN }),
});
if (!login.ok) {
  console.error(`\nВход не прошёл (${login.status}). Часть цифр без токена не видна: состав команды, клиенты, уведомления`);
  console.error('Задайте OWNER_EMAIL и OWNER_PIN живой учётки владельца и повторите');
  process.exit(1);
}
const { token } = await login.json();

// ── Что исчезнет ────────────────────────────────────────────────────────────
const bookings = (await json('bookings', token)).bookings ?? [];
const byStatus = bookings.reduce((acc, b) => ({ ...acc, [b.status]: (acc[b.status] ?? 0) + 1 }), {});
const dates = bookings.map((b) => b.date).filter(Boolean).sort();
// ?all=true - вся база клиентов (Окно 21.08.2026). Пустой GET /clients отвечает 400
// сознательно, чтобы опечатка в адресе не отдавала телефоны всего салона
const clients = asList(await json('clients?all=true', token));
const shifts = asList(await json('schedule', token));
const breaks = shifts.reduce((sum, s) => sum + (s.breaks?.length ?? 0), 0);
// Уведомления лежат по сотрудникам: роут отдаёт только ленту вошедшего
const notifications = asList(await json('notifications', token));

line('ИСЧЕЗНЕТ ПОСЛЕ СБРОСА');
console.log(`  записи (bookings): ${bookings.length}${dates.length ? `, даты с ${dates[0]} по ${dates[dates.length - 1]}` : ''}`);
console.log(`  по статусам: ${Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(', ') || 'нет записей'}`);
console.log(`  клиенты (clients): ${clients.length}`);
console.log(`  разовые смены (schedule_shifts): ${shifts.length}, перерывов в них (schedule_breaks): ${breaks}`);
console.log(`  уведомления, видимые вошедшему (${EMAIL}): ${notifications.length}`);
console.log('  уведомления лежат по сотрудникам, и публичного счётчика по всем сразу в API нет:');
console.log('  полное число по каждой таблице печатает сам сброс в логе старта приложения');
console.log(`  вместе с ними уходят состав услуг записей и допродажи; всего очищается таблиц: ${RESET_TABLES.length} (${RESET_TABLES.join(', ')})`);

// ── Кому будет записан график ───────────────────────────────────────────────
const staff = asList(await json('staff', token));
const employed = staff.filter((s) => s.employed !== false);
line(`ПОЛНЫЙ СОСТАВ КОМАНДЫ: ${staff.length} человек, в штате ${employed.length}`);
console.log('  id | роль | имя | почта-логин | в штате | принимает клиентов');
for (const person of staff) {
  console.log(`  ${person.id} | ${person.role} | ${person.name} | ${person.email ?? '(нет)'} | ${person.employed === false ? 'уволен' : 'да'} | ${person.providesServices ? 'да' : 'нет'}`);
}

line(`ГРАФИК ${RESET_SCHEDULE.workStart}-${RESET_SCHEDULE.workEnd} с перерывом ${RESET_SCHEDULE.breakStart}-${RESET_SCHEDULE.breakEnd} будет записан на все 7 дней недели каждому из ${employed.length} сотрудников в штате`);
console.log(`  строк в master_weekly_schedule станет ровно ${employed.length * 7}`);
console.log('  уволенным график не пишется, их прежние строки графика снимаются');

line('НЕ ТРОГАЕТСЯ');
console.log('  состав команды, учётные записи и PIN, услуги и цены, компетенции мастеров, фото и витрина');
console.log('  точки, ставки и настройки зарплат, скидки, производственный календарь, открытые сессии');
console.log('  данные второго арендатора: сброс идёт в контексте арендатора 1, замок из миграции 058 чужие строки не отдаёт');

line('ЧТО БУДЕТ ЗАПУЩЕНО (после явного «запускай»)');
console.log('  переменная в панели Amvera: RESET_TENANT_DATA=1:Барбершоп Алихан:peredacha-zakazchiku-2026-08-27');
console.log('  затем перезапуск приложения; повторный старт с той же меткой не удалит ничего');
console.log('  снимок всех удаляемых строк ляжет в kv_store ключом data-reset:peredacha-zakazchiku-2026-08-27');
