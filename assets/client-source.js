// Откуда пришёл клиент (17.08.2026, задача Влада: "в карточке записи 'День' -
// комментарий, откуда пришёл клиент, через яндекс карты или 2гис").
//
// Один словарь на весь проект: ключ уезжает в базу (bookings.client_source, миграция
// 050), подпись показывается человеку. Разъехаться им нельзя - иначе владелец увидит
// в карточке "2gis", а в отчёте "2ГИС" и посчитает это двумя каналами. Зеркало
// допустимых ключей на сервере - CLIENT_SOURCE_KEYS (api/routes/bookings.js), там же
// нормализация: что попадёт в базу, решает сервер, а не интерфейс.
//
// Файл используют обе стороны: публичный виджет записи (app.js - определяет источник
// сам) и CRM (assets/crm-walkin.js - выбор администратора, assets/crm-calendar.js -
// подпись на карточке дня).
export const CLIENT_SOURCE_LABELS = {
  yandex_maps: 'Яндекс Карты',
  '2gis': '2ГИС',
  instagram: 'Инстаграм',
  telegram: 'Телеграм',
  vk: 'ВКонтакте',
  referral: 'По рекомендации',
  walkin: 'Зашёл мимо',
  other: 'Другое',
};

export const CLIENT_SOURCE_KEYS = Object.keys(CLIENT_SOURCE_LABELS);

export function clientSourceLabel(key) {
  return CLIENT_SOURCE_LABELS[key] ?? null;
}

// Ключ, под которым первое касание лежит в localStorage. Определять источник в момент
// отправки формы недостаточно: клиент приходит по ссылке с меткой, потом листает сайт,
// открывает прайс, возвращается - и utm_source в адресе к тому времени уже нет.
const STORAGE_KEY = 'alikhan_client_source';

// utm_source может прийти в любом написании - метку ставит человек руками в карточке
// организации. Приводим к нашим ключам, но НЕ угадываем: чего нет в таблице, то не
// источник (вернём null), а не "other" - "другое" это осознанный выбор администратора
// в CRM, а не мусор из адресной строки.
const UTM_TO_KEY = {
  yandex_maps: 'yandex_maps',
  yandex: 'yandex_maps',
  yandexmaps: 'yandex_maps',
  maps: 'yandex_maps',
  '2gis': '2gis',
  '2GIS': '2gis',
  dvagis: '2gis',
  instagram: 'instagram',
  ig: 'instagram',
  telegram: 'telegram',
  tg: 'telegram',
  vk: 'vk',
  vkontakte: 'vk',
};

// Кто нас открыл, когда метки нет. Сознательно узкий список: домен → канал, без
// эвристик по подстрокам ("maps" встречается и в чужих адресах).
const REFERRER_RULES = [
  { test: (host, path) => /(^|\.)yandex\.[a-z.]+$/.test(host) && path.startsWith('/maps'), key: 'yandex_maps' },
  { test: (host) => /(^|\.)yandex\.[a-z.]+$/.test(host), key: 'yandex_maps' },
  { test: (host) => /(^|\.)2gis\.[a-z.]+$/.test(host), key: '2gis' },
  { test: (host) => /(^|\.)instagram\.com$/.test(host), key: 'instagram' },
  { test: (host) => /(^|\.)t\.me$/.test(host) || /(^|\.)telegram\.org$/.test(host), key: 'telegram' },
  { test: (host) => /(^|\.)vk\.com$/.test(host), key: 'vk' },
];

// Чистые функции ниже (без localStorage и window) - ровно то, что покрыто офлайн-тестом
// tests/client-source.detect.test.js.
export function sourceFromUtm(utmSource) {
  if (typeof utmSource !== 'string') return null;
  const raw = utmSource.trim();
  if (!raw) return null;
  return UTM_TO_KEY[raw] ?? UTM_TO_KEY[raw.toLowerCase()] ?? null;
}

export function sourceFromReferrer(referrer) {
  if (typeof referrer !== 'string' || !referrer) return null;
  let url;
  try {
    url = new URL(referrer);
  } catch {
    return null; // не адрес вовсе - гадать по строке не будем
  }
  // Только обычный веб-переход. Из приложения referrer приходит схемой
  // "android-app://ru.yandex.yandexmaps", и соблазн прочитать её как Яндекс Карты
  // велик - но такой строкой браузер представляет ЛЮБОЕ приложение, включая
  // поисковую строку и мессенджер, а сходство с доменом карт здесь случайное
  // (new URL разбирает "ru.yandex.yandexmaps" как хост). Гадать не будем: пусть поле
  // останется пустым, администратор проставит канал руками в CRM
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  for (const rule of REFERRER_RULES) {
    if (rule.test(host, path)) return rule.key;
  }
  return null;
}

// Приоритет: метка в адресе точнее referrer'а (её ставили осознанно), referrer -
// фолбэк. Ничего не сработало - null, и это честный ответ: из мобильного приложения
// карт браузер часто не передаёт referrer вовсе, и придумывать источник вместо
// администратора система не должна.
export function detectClientSource({ search, referrer } = {}) {
  const params = new URLSearchParams(search || '');
  return sourceFromUtm(params.get('utm_source')) ?? sourceFromReferrer(referrer) ?? null;
}

// Первое касание - то, по которому человек пришёл на сайт. Запоминаем его и дальше
// не перезаписываем: переход внутри сайта или возврат из чужой вкладки не должен
// подменять канал привлечения на "прямой заход".
export function rememberClientSource(storage = window.localStorage, loc = window.location, referrer = document.referrer) {
  try {
    const saved = storage.getItem(STORAGE_KEY);
    if (saved) return saved;
    const detected = detectClientSource({ search: loc.search, referrer });
    if (detected) storage.setItem(STORAGE_KEY, detected);
    return detected;
  } catch {
    // Приватный режим/запрет хранилища - работаем без памяти, источник определится
    // по текущему адресу. Запись клиента из-за этого падать не должна
    return detectClientSource({ search: loc?.search, referrer });
  }
}

export function currentClientSource(storage = window.localStorage) {
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
