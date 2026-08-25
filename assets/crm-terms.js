// Слой применения словаря вертикали в кабинетах (Этап B, Фаза 2, 24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// Кабинет забирает слова у сервера при старте: GET /tenant/appearance по своему
// домену. Своего словаря он не сочиняет - здесь лежат только ЗАПАСНЫЕ слова на случай,
// когда сервер не ответил. Запасные - барбершопные, ровно те же, что на сервере:
// совпадение слово в слово проверяет tests/crm-terms.test.js, разойтись молча они не
// могут. Барбершоп выбран запасным не случайно - у Алихана боевой кабинет, и любая
// поломка загрузки обязана оставить его ровно таким, каким он был.
//
// Правило отката работает на каждом уровне: нет ответа - барбершопный словарь; нет
// термина в ответе - барбершопный термин; нет формы - барбершопная форма; нет ключа
// нигде - отдаём сам ключ, чтобы пропуск было видно глазами, а не по пустому месту.

export const FALLBACK = Object.freeze({
  vertical: 'barbershop',
  terms: {
    "master": {
      "g": "m",
      "nom": "мастер",
      "gen": "мастера",
      "dat": "мастеру",
      "acc": "мастера",
      "ins": "мастером",
      "pre": "мастере",
      "nomPl": "мастера",
      "genPl": "мастеров",
      "datPl": "мастерам",
      "accPl": "мастеров",
      "insPl": "мастерами",
      "prePl": "мастерах"
    },
    "booking": {
      "g": "f",
      "nom": "запись",
      "gen": "записи",
      "dat": "записи",
      "acc": "запись",
      "ins": "записью",
      "pre": "записи",
      "nomPl": "записи",
      "genPl": "записей",
      "datPl": "записям",
      "accPl": "записи",
      "insPl": "записями",
      "prePl": "записях"
    },
    "service": {
      "g": "f",
      "nom": "услуга",
      "gen": "услуги",
      "dat": "услуге",
      "acc": "услугу",
      "ins": "услугой",
      "pre": "услуге",
      "nomPl": "услуги",
      "genPl": "услуг",
      "datPl": "услугам",
      "accPl": "услуги",
      "insPl": "услугами",
      "prePl": "услугах"
    },
    "client": {
      "g": "m",
      "nom": "клиент",
      "gen": "клиента",
      "dat": "клиенту",
      "acc": "клиента",
      "ins": "клиентом",
      "pre": "клиенте",
      "nomPl": "клиенты",
      "genPl": "клиентов",
      "datPl": "клиентам",
      "accPl": "клиентов",
      "insPl": "клиентами",
      "prePl": "клиентах"
    },
    "place": {
      "g": "m",
      "nom": "салон",
      "gen": "салона",
      "dat": "салону",
      "acc": "салон",
      "ins": "салоном",
      "pre": "салоне",
      "nomPl": "салоны",
      "genPl": "салонов",
      "datPl": "салонам",
      "accPl": "салоны",
      "insPl": "салонами",
      "prePl": "салонах"
    }
  },
  phrases: {
    "booking.new": "Новая запись",
    "booking.cancelled": "Запись отменена",
    "booking.movedOut": "Запись ушла к другому мастеру",
    "booking.movedIn": "Перенесена запись к вам",
    "booking.moved": "Запись перенесена",
    "booking.movedOutPlace": "Запись ушла с точки",
    "booking.movedInPlace": "Запись перенесена на точке",
    "client.missedLast": "Пропустил последнюю запись - стоит позвонить"
  },
  modules: {
    "missedProfit": true,
    "payroll": true
  },
});

let current = FALLBACK;

export function currentAppearance() {
  return current;
}

// Нужен тестам и повторному входу: после выхода из системы кабинет может открыть
// другой человек, и словарь должен вернуться к исходному состоянию
export function resetAppearance() {
  current = FALLBACK;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Ответ сервера - данные из сети, а не обещание. Берём из него только то, что похоже
// на слова, остальное достраиваем запасным словарём. Дыра в ответе не должна
// оборачиваться пустой надписью на экране
function mergeAppearance(payload) {
  if (!isPlainObject(payload)) return FALLBACK;
  const terms = {};
  for (const [key, fallbackForms] of Object.entries(FALLBACK.terms)) {
    const incoming = isPlainObject(payload.terms) && isPlainObject(payload.terms[key]) ? payload.terms[key] : {};
    terms[key] = { ...fallbackForms };
    for (const [form, value] of Object.entries(incoming)) {
      if (typeof value === 'string' && value.trim()) terms[key][form] = value;
    }
  }
  const phrases = { ...FALLBACK.phrases };
  if (isPlainObject(payload.phrases)) {
    for (const [key, value] of Object.entries(payload.phrases)) {
      if (typeof value === 'string' && value.trim()) phrases[key] = value;
    }
  }
  const modules = { ...FALLBACK.modules };
  if (isPlainObject(payload.modules)) {
    for (const [key, value] of Object.entries(payload.modules)) {
      if (typeof value === 'boolean' && key in FALLBACK.modules) modules[key] = value;
    }
  }
  const vertical = typeof payload.vertical === 'string' && payload.vertical.trim()
    ? payload.vertical
    : FALLBACK.vertical;
  return { vertical, terms, phrases, modules };
}

// Токена здесь нет и быть не может: слова нужны экрану входа, то есть раньше, чем
// человек вошёл. Роут на сервере публичный ровно поэтому
export async function loadAppearance(apiBase, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${apiBase}/tenant/appearance`, { credentials: 'omit' });
    if (!res?.ok) {
      current = FALLBACK;
      return current;
    }
    current = mergeAppearance(await res.json());
  } catch {
    // Сеть легла, сервер спит, домен не заведён - кабинет всё равно должен открыться.
    // У Алихана это буквально означает «ничего не изменилось»
    current = FALLBACK;
  }
  return current;
}

export function T(path) {
  const raw = typeof path === 'string' ? path : '';
  if (!raw) return '';
  const [key, form = 'nom'] = raw.split('.');
  const value = current.terms?.[key]?.[form] ?? FALLBACK.terms?.[key]?.[form];
  return typeof value === 'string' ? value : raw;
}

export function Tc(path) {
  const value = T(path);
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function P(key) {
  const raw = typeof key === 'string' ? key : '';
  if (!raw) return '';
  const value = current.phrases?.[raw] ?? FALLBACK.phrases?.[raw];
  return typeof value === 'string' ? value : raw;
}

// Русское склонение числительного - та же формула, что на сервере
// (api/lib/vertical-terms.js), и те же данные: именительный, родительный
// единственного и родительный множественного
export function C(key, n) {
  const value = Math.abs(Number(n) || 0);
  const tens = value % 100;
  const ones = value % 10;
  if (ones === 1 && tens !== 11) return T(`${key}.nom`);
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return T(`${key}.gen`);
  return T(`${key}.genPl`);
}

// Неизвестный флаг выключен, а не включён: раздел, о котором словарь ничего не знает,
// безопаснее не показать, чем показать по недосмотру
export function moduleEnabled(key) {
  return current.modules?.[key] === true;
}

// Подстановка в готовую разметку. В HTML кабинета остаётся написанным барбершопное
// слово - оно и служит запасным вариантом, если скрипт вообще не отработал:
//   <span data-term="master.nomPl" data-term-cap>Мастера</span>
//   <span data-phrase="booking.new">Новая запись</span>
//   <input data-term-attr="placeholder:client.nom" placeholder="клиент">
export function applyTerms(root = (typeof document === 'undefined' ? null : document)) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const node of root.querySelectorAll('[data-term]')) {
    const path = node.getAttribute('data-term');
    if (!path) continue;
    node.textContent = node.hasAttribute('data-term-cap') ? Tc(path) : T(path);
  }
  for (const node of root.querySelectorAll('[data-phrase]')) {
    const key = node.getAttribute('data-phrase');
    if (!key) continue;
    node.textContent = P(key);
  }
  for (const node of root.querySelectorAll('[data-term-attr]')) {
    const spec = node.getAttribute('data-term-attr') ?? '';
    const at = spec.indexOf(':');
    if (at <= 0) continue;
    const attr = spec.slice(0, at).trim();
    const path = spec.slice(at + 1).trim();
    if (!attr || !path) continue;
    node.setAttribute(attr, T(path));
  }
}
