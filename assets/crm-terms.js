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
  // Тема оформления. `default` - вид, который был у кабинета всегда: сеть легла или
  // сервер молчит, значит «осталось как было», а не голый экран
  theme: 'default',
  name: 'CRM',
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
    "push.hintOn": "Включены на этом устройстве. Телефон покажет уведомление о новой записи, даже когда кабинет закрыт",
    "push.hintOff": "Сейчас выключены. Включите, чтобы узнавать о новых записях, не открывая кабинет",
    "push.iosInstall": "Чтобы получать уведомления о записях на айфон, откройте этот кабинет через кнопку «Поделиться» внизу Safari, выберите «На экран Домой», а потом запустите приложение с экрана и включите уведомления здесь же",
    "push.enabled": "Готово. Телефон будет показывать уведомления о новых записях",
    "booking.new": "Новая запись",
    "booking.newForSlot": "Новая запись на выбранное время",
    "booking.walkin": "Новая запись без предзаписи",
    "booking.repeat": "Повторная запись",
    "booking.notFound": "запись не найдена - возможно, её уже удалили",
    "booking.cancelledCantEdit": "запись отменена - править её нельзя, создайте новую",
    "booking.cancelledCantMove": "запись отменена - перенести её нельзя, создайте новую",
    "booking.noRightsEdit": "нет прав править эту запись (другая точка)",
    "booking.noRightsMove": "нет прав переносить эту запись (другая точка)",
    "booking.overlapOther": "на это время у мастера уже есть другая запись - выберите свободное",
    "booking.pastTimeCreate": "нельзя записать в прошлое",
    "booking.noBookableMaster": "Нет мастера с рабочим графиком для новой записи",
    "booking.foreignServices": "новый мастер не оказывает часть услуг этой записи - поправьте список услуг",
    "booking.comboConflict": "В этой записи комплекс и отдельная услуга, которая уже в него входит - снимите лишнюю галочку, иначе сохранить не получится",
    "booking.cancelled": "Запись отменена",
    "booking.movedOut": "Запись ушла к другому мастеру",
    "booking.movedIn": "Перенесена запись к вам",
    "booking.moved": "Запись перенесена",
    "booking.movedOutPlace": "Запись ушла с точки",
    "booking.movedInPlace": "Запись перенесена на точке",
    "client.missedLast": "Пропустил последнюю запись - стоит позвонить",
    "msg.cancelled": "Ваша запись {when} отменена",
    "msg.expected": "Ждём вас {when}",
    "booking.cancelledShort": "Запись отменена",
    "booking.deleted": "Запись удалена",
    "booking.notInSchedule": "Запись не найдена в расписании - возможно, её отменили",
    "booking.deleteConfirm": "Удалить запись безвозвратно? Из статистики и зарплаты тоже пропадёт",
    "booking.deleteFailed": "Не удалось удалить запись",
    "booking.noRightsChange": "нет прав менять эту запись (другая точка)",
    "booking.notOpened": "запись не открыта",
    "booking.outsideHours": "Запись вне рабочих часов мастера",
    "booking.expand": "Раскрыть запись",
    "booking.collapse": "Свернуть запись",
    "booking.open": "Открыть запись",
    "booking.opening": "Открываю запись",
    "booking.created": "запись создана",
    "booking.emptyBell": "Новых записей нет. Всё, что было, осталось в разделе «Уведомления»",
    "booking.emptyFeed": "Пока ни одной новой записи. Здесь появится каждая запись клиента - сразу, как её создадут на сайте или в CRM",
    "booking.saleAttached": "К данной записи привязана продажа ({sum}), которая участвует в расчёте ЗП. Подтверждаете удаление?",
    "booking.deletedRefresh": "Запись удалена. Обновите страницу, чтобы календарь пересчитался",
    "service.addedToBooking": "Услуга добавлена к записи",
    "schedule.noneCantBook": "Нет графика - клиенты не могут записаться",
    "schedule.dayOff": "Выходной, записи не будет",
    "schedule.noBookingsThatDay": "Записи в этот день нет",
    "schedule.breakNoBooking": "В это время записи не будет",
    "schedule.conflictSave": "Нельзя сохранить график: на это время уже есть записи, они перечислены ниже",
    "schedule.conflictSaveDay": "Нельзя сохранить день: на это время уже есть записи, они перечислены ниже",
    "schedule.savedWithConflicts": "Сохранено. На это время уже есть {count} реальных записей - в колокольчике уведомлений появилось, с кем связаться",
    "schedule.notClosedConflicts": "не закрыто из-за записей",
    "booking.detailsTitle": "Детали выбранного визита",
    "booking.addToSchedule": "Добавить клиента в расписание",
    "bell.aria": "Уведомления и клиенты, которым стоит позвонить",
    "bell.ariaShort": "Уведомления о записях и графике",
    "master.yearHint": "Год - только мои записи. Праздники - официальный календарь РФ",
    "master.commission": "Моя комиссия за запись",
    "field.clientName": "Имя клиента",
    "field.clientSource": "Откуда клиент",
    "field.priceHint": "как по услугам",
    "field.staffComment": "Комментарий к записи и клиенту",
    "field.staffCommentHint": "например: владелец дал скидку постоянному клиенту; чем длиннее, тем лучше - заметка видна в карточке клиента",
    "booking.save": "Сохранить запись",
    "booking.addSale": "Добавить продажу к этой записи",
    "client.rebook": "Записать снова",
    "renew.noPhone": "Срок возврата у этой записи не спрашиваем - у клиента не указан телефон, напоминать некому. Впишите номер в поле «Телефон» выше, если хотите вести его историю и видеть его в «Недополученной прибыли»",
    "renew.whenAgain": "Когда клиенту прийти снова",
    "renew.correctDays": "А правильно для этой стрижки, дней",
    "renew.required": "Выберите срок и причину - без этого визит не закрыть. Не обсуждали срок с клиентом? Так и отметьте, это нормальный ответ",
    "payroll.mastersTitle": "Зарплаты мастеров",
    "analytics.retention": "Возвращаемость клиентов",
    "analytics.sources": "Как приходят клиенты",
    "team.roleMaster": "Свои записи и график",
    "team.roleAdmin": "Записи и клиенты своей точки",
    "team.noProfile": "Профиль появится после настройки услуг и графика",
    "team.servicesByOwner": "Услуги и длительность назначает владелец",
    "team.servicesOwnerSelf": "Услуги владельца меняет только он сам",
    "team.pickServices": "Выберите услуги и укажите длительность",
    "team.acceptsClients": "Принимает клиентов",
    "team.acceptsHint": "Можно назначить услуги и открыть запись",
    "team.acceptsHintNew": "Услуги и график нужно настроить отдельно",
    "team.publicProfileHint": "Фото и информация для клиентов",
    "team.servicesSection": "Услуги и время",
    "team.historyKept": "История записей, выручки и статистики за отработанные периоды сохранена - она видна в «Финансах» и «Аналитике»",
    "team.firedHistoryKept": "Не работают в компании. Записи, выручка и статистика за отработанные периоды сохранены",
    "team.servicesSaveFailed": "Не удалось сохранить услуги",
    "team.scheduleConflict": "График не сохранён: на это время уже есть записи, они показаны в блоке «График»",
    "team.exceptionConflict": "На это время уже есть запись - разовое изменение не сохранено",
    "team.fireConfirm": "Уволить «{name}»? Он пропадёт из расписания и с сайта записи, вход в CRM закроется сразу. Записи, выручка и статистика за отработанные периоды останутся на месте. Будущие записи к нему перенесите на другого мастера",
    "clients.noneToCall": "Нет клиентов, которым сейчас стоит позвонить",
    "clients.loadListFailed": "Не удалось загрузить список клиентов",
    "clients.loadCardFailed": "Не удалось загрузить карточку клиента",
    "clients.loadingCard": "Загружаю карточку клиента",
    "clients.loadHistoryFailed": "Не удалось загрузить историю клиента",
    "clients.loadBaseFailed": "Не удалось загрузить базу клиентов",
    "clients.empty": "Клиентов пока нет. Клиент появляется здесь сам, когда его записали с номером телефона",
    "clients.openVisitTitle": "Открыть эту запись в расписании",
    "clients.cancelledNoVisit": "Отменённой записи в расписании нет",
    "clients.openVisitFailed": "Не удалось открыть запись в расписании - обновите страницу",
    "clients.openVisitError": "Не удалось открыть запись в расписании",
    "clients.renewEmpty": "Срок не поставлен - появится, когда мастер закроет визит",
    "analytics.noBookings": "Записей {period} не было",
    "analytics.totalBookings": "Всего записей: {total}",
    "analytics.noClients": "Нет клиентов",
    "analytics.unlinkedNote": "Визиты, клиента не опознать",
    "analytics.renewDefaultNote": "Остальным поставлен месяц по умолчанию - это нормальный ответ мастера, но чем таких меньше, тем точнее «Недополученная прибыль» в «Финансах»",
    "analytics.noSuchClients": "{title}: таких клиентов нет",
    "analytics.lapsedTitle": "Не вернулись к мастеру: {name}",
    "msg.comeBack": "Давно вас не видели - будем рады снова записать вас к мастеру. Подобрать удобное время?",
    "msg.refresh": "Пора обновить стрижку - подобрать вам удобное время?",
    "missed.sparseLabel": "Ходят реже, чем нужно стрижке",
    "missed.legend": "Потеря - визитов не было и деньги не пришли. Клиенты, которые ходят реже, ничего салону не должны: это не потеря, а то, что можно вернуть разговором о сроке",
    "schedule.masterUnbookable": "Мастер {name} - клиенты не могут записаться",
    "booking.pickInSchedule": "Выберите запись в расписании - здесь появятся её детали",
    "booking.servicesUnknown": "Услуги по этой записи не указаны",
    "renew.waitingClient": "Ждём клиента через {days}",
    "renew.byMasterAdvice": "по рекомендации мастера",
    "renew.reasonRecommended": "Мастер назвал срок, клиент согласился",
    "renew.reasonHair": "Особенность волос или формы стрижки",
    "renew.script1": "Назовите срок: «ваша стрижка держит форму N недель».",
    "renew.script2": "Спросите, готов ли клиент ходить так часто ради результата.",
    "renew.script3": "Не готов - поставьте удобный ему срок и предложите стрижку, которая хорошо выглядит весь этот срок.",
    "payroll.pickServices": "Выберите услуги, чтобы увидеть комиссию",
    "payroll.noneAccepting": "Пока никто из сотрудников не принимает клиентов - включите \"Принимает клиентов\" в разделе \"Сотрудники\"",
    "service.topMasterHint": "Топ-мастер по этой услуге - на сайте клиент выбирает его отдельным тарифом",
    "service.comboOf": "Состоит из услуг {names} - по отдельности сейчас {sum}",
    "service.priceAria": "Цена услуги «{name}»",
    "booking.topTariff": "запись к топ-мастеру",
    "holidays.closeAll": "Закрыть выбранные даты всем мастерам",
    "holidays.closeCount": "Закрыть {count} {days} всем мастерам",
    "holidays.closedTotal": "Закрыто дней у мастеров: {count}",
    "schedule.needWorkHours": "{day}: укажите, с какого и до какого часа мастер работает"
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
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : FALLBACK.name;
  // Имя темы приходит в разметку атрибутом, поэтому в нём допущены только буквы,
  // цифры и дефис: сервер свой, но подставлять его ответ в DOM без проверки нельзя
  const theme = typeof payload.theme === 'string' && /^[a-z0-9-]{1,32}$/.test(payload.theme)
    ? payload.theme
    : FALLBACK.theme;
  return { vertical, theme, name, terms, phrases, modules };
}

// Токена здесь нет и быть не может: слова нужны экрану входа, то есть раньше, чем
// человек вошёл. Роут на сервере публичный ровно поэтому
// ── Тема оформления ────────────────────────────────────────────────────────────
// Тему выбирает сервер по вертикали арендатора, а красит CSS: файл темы подключён
// всегда, но каждое его правило висит на [data-theme="<имя>"], поэтому у кабинета с
// другой темой он не применяет ни одного правила.
//
// Ответ сервера приходит по сети, то есть ПОСЛЕ первой отрисовки. Без кэша это
// означало бы вспышку чужой палитры на каждом открытии кабинета. Поэтому имя темы
// кладётся в localStorage, а короткий скрипт в <head> трёх crm-*.html ставит атрибут
// из кэша ещё до отрисовки. Сеть остаётся источником истины: пришедшее значение
// перезаписывает и атрибут, и кэш.
export const THEME_STORAGE_KEY = 'crm.theme';

export function applyTheme(theme = current.theme) {
  const value = typeof theme === 'string' && /^[a-z0-9-]{1,32}$/.test(theme) ? theme : FALLBACK.theme;
  const root = globalThis.document?.documentElement;
  if (root) root.dataset.theme = value;
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // Приватный режим и заблокированное хранилище - не повод ронять кабинет: без
    // кэша тема просто применится на кадр позже
  }
  return value;
}

export async function loadAppearance(apiBase, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${apiBase}/tenant/appearance`, { credentials: 'omit' });
    if (!res?.ok) {
      current = FALLBACK;
      return current;
    }
    current = mergeAppearance(await res.json());
    // Тема применяется ТОЛЬКО по успешному ответу - и здесь же, а не у вызывающего:
    // иначе моргнувшая сеть означала бы «оставить как есть» для слов и «перекрасить
    // в чужое» для темы. Кэш при провале не трогается вовсе, поэтому кабинет
    // остаётся в своём виде, даже когда сервер молчит
    applyTheme(current.theme);
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

// Подстановка {имя}: фразу, в которой рядом с термином стоит и согласуемое слово, и
// живые данные, разрезать на куски нельзя - согласование потеряется
export function P(key, vars = null) {
  const raw = typeof key === 'string' ? key : '';
  if (!raw) return '';
  const value = current.phrases?.[raw] ?? FALLBACK.phrases?.[raw];
  if (typeof value !== 'string') return raw;
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name] ?? '') : whole));
}

// Название самого заведения: у Алихана «барбершоп «Алихан»», у Карины - её клиника.
// Термином вертикали это не лечится, название живёт в справочнике арендаторов
export function tenantName() {
  return current.name || FALLBACK.name;
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
//   <input data-phrase-attr="placeholder:booking.pricePlaceholder" placeholder="как по услугам">
export function applyTerms(root = (typeof document === 'undefined' ? null : document)) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  // Раздел, выключенный у арендатора, убирается с экрана. Настоящая защита - на
  // сервере (реестр роутов отдаёт 404), здесь только чтобы человек не видел пустой
  // блок и не жал в него
  for (const node of root.querySelectorAll('[data-module]')) {
    const key = node.getAttribute('data-module');
    if (key) node.hidden = !moduleEnabled(key);
  }
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
  for (const node of root.querySelectorAll('[data-phrase-attr]')) {
    const spec = node.getAttribute('data-phrase-attr') ?? '';
    const at = spec.indexOf(':');
    if (at <= 0) continue;
    const attr = spec.slice(0, at).trim();
    const key = spec.slice(at + 1).trim();
    if (!attr || !key) continue;
    node.setAttribute(attr, P(key));
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
  // Название заведения - такая же принадлежность арендатора, как и словарь: до
  // 28.08.2026 оно было зашито в разметку («Алихан — CRM» в заголовке вкладки,
  // «барбершоп «Алихан»» на экране входа), и клиника Карины видела бы чужой бренд
  // в собственном кабинете
  const name = tenantName();
  if (name) {
    for (const node of root.querySelectorAll('.brand-name, .login-brand-name')) {
      node.textContent = name;
    }
    if (typeof document !== 'undefined' && root === document) {
      // Роль в заголовке вкладки («· Владелец») остаётся - меняется только заведение
      const role = document.title.split('·').slice(1).join('·').trim();
      document.title = role ? `${name} — CRM · ${role}` : `${name} — CRM`;
    }
  }
}

// Мост для обычных скриптов. assets/mockup-crm.js подключён тегом <script> без
// type="module" и импортировать ничего не может, а надписи в нём такие же живые, как
// в остальных кабинетах. Переписывать его на модуль ради словаря - работа не этого
// окна, поэтому словарь просто выкладывается в window
if (typeof window !== 'undefined') {
  window.__crmTerms = { T, Tc, P, C, moduleEnabled, tenantName, currentAppearance };
}
