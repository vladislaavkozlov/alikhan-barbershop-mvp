// Окно 72 (28.08.2026) - перевод входа на человеческие логины и пароли.
//
// Что делает. Переименовывает логины сотрудников салона (master1-test@alikhan.test
// … master5-test@alikhan.test - служебные заготовки с несуществующего домена) в
// имена людей латиницей и задаёт каждому новый пароль. Прежние пароли лежали
// открытым текстом в публичном репозитории, поэтому меняются все без исключения.
//
// Почему скриптом, а не миграцией. Правило проекта: миграции - только про схему.
// Инцидент 04.08.2026 (миграция с DELETE FROM staff уронила прод на 20 минут)
// стоил ровно этого правила. Данные конкретного окна правятся через API, как и
// сброс данных перед передачей (окно 70).
//
// Запуск. Сначала вхолостую - показывает план и ничего не трогает:
//   OWNER_LOGIN=<текущий логин> OWNER_PIN=<текущий пароль> node tools/okno72-loginy.mjs
// Затем по-настоящему:
//   OWNER_LOGIN=... OWNER_PIN=... node tools/okno72-loginy.mjs --apply
//
// Новые пароли печатаются в терминал один раз и никуда не сохраняются.
import { randomInt } from 'node:crypto';

const API = process.env.API_URL ?? 'https://alikhancrm1-vladislaavkozlov.amvera.io';
const ORIGIN = process.env.ORIGIN ?? 'https://vladislaavkozlov.github.io';
const LOGIN = process.env.OWNER_LOGIN ?? process.env.OWNER_EMAIL;
const PIN = process.env.OWNER_PIN;
const APPLY = process.argv.includes('--apply');

if (!LOGIN || !PIN) {
  console.error('Нужны текущие доступы владельца: OWNER_LOGIN=<логин> OWNER_PIN=<пароль> node tools/okno72-loginy.mjs [--apply]');
  process.exit(1);
}

// Карта переименования: старый логин -> новый. Имена взяты из карточек сотрудников,
// администратор - общий кабинет точки, поэтому у него не имя, а роль.
const RENAME = new Map([
  ['master1-test@alikhan.test', 'aliovsad'],
  ['master2-test@alikhan.test', 'mamedhan'],
  ['master3-test@alikhan.test', 'elizaveta'],
  ['master4-test@alikhan.test', 'admin'],
  ['master5-test@alikhan.test', 'renat'],
]);

// Пароль вида «слово-4 цифры»: его можно продиктовать по телефону и набрать с
// планшета, при этом он не подбирается перебором за разумное время.
const WORDS = ['barber', 'stavropol', 'nozhnicy', 'mashinka', 'britva', 'salon', 'zerkalo', 'kreslo'];
const newPassword = () => `${WORDS[randomInt(WORDS.length)]}-${String(randomInt(1000, 10000))}`;

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

const login = await api('/auth/login', { method: 'POST', body: { login: LOGIN, password: PIN, email: LOGIN, pin: PIN } });
if (!login.ok) {
  console.error('Вход владельца не прошёл:', login.status, login.data);
  process.exit(1);
}
const token = login.data.token;
console.log(`Вход выполнен: ${login.data.staff.name}, роль ${login.data.staff.role}\n`);

const staffRes = await api('/staff', { token });
if (!staffRes.ok) {
  console.error('Не удалось получить состав команды:', staffRes.status, staffRes.data);
  process.exit(1);
}
const staff = Array.isArray(staffRes.data) ? staffRes.data : staffRes.data.staff;

const plan = staff.map((person) => ({
  person,
  newLogin: RENAME.get(person.email) ?? null,
  password: newPassword(),
}));

console.log(APPLY ? 'ПРИМЕНЯЮ ИЗМЕНЕНИЯ\n' : 'ВХОЛОСТУЮ - ничего не меняю, показываю план\n');
for (const item of plan) {
  const mark = item.newLogin ? `${item.person.email} -> ${item.newLogin}` : `${item.person.email} - в карте переименования нет, пропускаю`;
  console.log(` ${item.person.role.padEnd(8)} ${String(item.person.name).padEnd(24)} ${mark}`);
}
console.log('');

if (!APPLY) {
  console.log('Ничего не изменено. Повторите с флагом --apply, чтобы применить.');
  process.exit(0);
}

// Порядок важен. Сначала логины: смена логина владельца не рвёт его сессию, она
// держится на идентификаторе сотрудника, а не на паре логин-пароль. Пароль самому
// себе меняем последним - по той же причине сессия переживёт и это, но если что-то
// пойдёт не так раньше, у владельца ещё остаётся рабочий вход.
const results = [];
const ordered = [...plan].sort((a, b) => (a.person.role === 'owner' ? 1 : 0) - (b.person.role === 'owner' ? 1 : 0));

for (const item of ordered) {
  if (!item.newLogin) continue;
  // PUT /staff/:id перезаписывает карточку целиком - переносим текущие значения,
  // иначе точка и признак «принимает клиентов» обнулятся вместе с переименованием.
  const update = await api(`/staff/${item.person.id}`, {
    method: 'PUT',
    token,
    body: {
      name: item.person.name,
      email: item.newLogin,
      phone: item.person.phone ?? '',
      locationId: item.person.locationId ?? null,
      providesServices: item.person.providesServices === true,
    },
  });
  if (!update.ok) {
    results.push({ ...item, error: `логин: ${update.status} ${JSON.stringify(update.data)}` });
    continue;
  }
  const pinSet = await api(`/staff/${item.person.id}/pin`, { method: 'PUT', token, body: { newPin: item.password } });
  if (!pinSet.ok) {
    results.push({ ...item, error: `пароль: ${pinSet.status} ${JSON.stringify(pinSet.data)}` });
    continue;
  }
  results.push({ ...item, error: null });
}

console.log('\n────────── ДОСТУПЫ ДЛЯ ПЕРЕДАЧИ ЗАКАЗЧИКУ ──────────\n');
for (const r of results) {
  if (r.error) {
    console.log(` ✗ ${r.person.name}: ${r.error}`);
  } else {
    console.log(` ${String(r.person.name).padEnd(24)} логин: ${String(r.newLogin).padEnd(12)} пароль: ${r.password}`);
  }
}
console.log('\nПароли показаны один раз и нигде не сохранены. Скопируйте их сейчас.');

const failed = results.filter((r) => r.error);
process.exit(failed.length ? 1 : 0);
