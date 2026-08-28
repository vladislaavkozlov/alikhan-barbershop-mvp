// Защита входа от перебора (Окно 72, 28.08.2026).
//
// Зачем. До этого окна счётчика попыток не было вообще: сервер отвечал на любое
// число запросов к POST /auth/login одинаково быстро. При четырёхзначном коде
// (а именно такой был у владельца) полный перебор - десять тысяч запросов,
// то есть минуты работы скрипта. Пароль от шести знаков перебор усложняет, но
// сам по себе счётчик нужен всё равно: люди ставят простые пароли.
//
// Как. Считаем неудачи по паре «логин + адрес запроса». После пяти промахов
// подряд пара уходит в паузу на пятнадцать минут; удачный вход обнуляет счётчик.
// Пара, а не один логин - чтобы чужой человек не мог намеренно запереть Али
// снаружи, засыпая его логин мусорными попытками.
//
// Хранение - в памяти процесса. Приложение живёт одним контейнером на Amvera,
// внешнего кэша у проекта нет и заводить его ради этого не стоит. Перезапуск
// контейнера обнуляет счётчики - приемлемо: перезапуск не по воле атакующего,
// а его окно всё равно короче паузы.
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const FORGET_MS = 60 * 60 * 1000;

const attempts = new Map();

// Логин обрезается до 64 знаков: в ключ попадает то, что прислал браузер, а
// отвергнутое normalizeLogin значение приходит в счётчик как есть. Без обрезки
// поток запросов с километровыми логинами раздувал бы карту в памяти сервера.
function keyFor(login, ip) {
  return `${String(login ?? '').slice(0, 64).toLowerCase()}|${String(ip ?? '-').slice(0, 64)}`;
}

// Потолок на число разных пар в памяти. Атака с тысяч адресов иначе съела бы
// память контейнера: пар много, каждая живёт час. При переполнении выкидываем
// самые старые - они и так ближе всех к истечению.
const MAX_TRACKED = 5000;

// Адрес запроса. За прокси Amvera реальный адрес приходит в X-Forwarded-For,
// прямое соединение даёт socket.remoteAddress.
export function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req?.socket?.remoteAddress ?? '-';
}

// Подчищаем протухшие записи, чтобы карта не росла бесконечно на живом сервере.
function sweep(now) {
  for (const [key, entry] of attempts) {
    if (now - entry.lastAt > FORGET_MS) attempts.delete(key);
  }
}

// null = можно пробовать. Число = сколько секунд ждать.
export function retryAfterSeconds(login, ip, now = Date.now()) {
  const entry = attempts.get(keyFor(login, ip));
  if (!entry || !entry.lockedUntil) return null;
  if (entry.lockedUntil <= now) return null;
  return Math.ceil((entry.lockedUntil - now) / 1000);
}

export function registerFailure(login, ip, now = Date.now()) {
  sweep(now);
  if (attempts.size >= MAX_TRACKED) {
    const oldest = [...attempts.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt).slice(0, Math.ceil(MAX_TRACKED / 10));
    for (const [key] of oldest) attempts.delete(key);
  }
  const key = keyFor(login, ip);
  const entry = attempts.get(key) ?? { failures: 0, lockedUntil: 0, lastAt: now };
  // Пауза истекла - счётчик начинается заново, а не продолжает старый.
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    entry.failures = 0;
    entry.lockedUntil = 0;
  }
  entry.failures += 1;
  entry.lastAt = now;
  if (entry.failures >= MAX_FAILURES) entry.lockedUntil = now + LOCK_MS;
  attempts.set(key, entry);
  return entry;
}

export function registerSuccess(login, ip) {
  attempts.delete(keyFor(login, ip));
}

// Только для тестов - живой сервер состояние между запросами не сбрасывает.
export function resetThrottle() {
  attempts.clear();
}

export const LOGIN_THROTTLE_LIMITS = { MAX_FAILURES, LOCK_MS };
