// Почему у клиента именно такой срок обновления стрижки (Окно 59, 22.08.2026).
// Закрытый список: ключи живут здесь и уезжают в базу (clients.renew_reason,
// миграция 056), человеческие подписи - на фронте (assets/renew-reason.js). Тот же
// приём, что у каналов привлечения (CLIENT_SOURCE_KEYS): свободный текст здесь
// означал бы, что «дорого» и «дороговато» - две разные причины, и посчитать по ним
// ничего нельзя.
export const RENEW_REASON_KEYS = ['recommended', 'hair', 'price', 'schedule', 'not_discussed'];

// Срок по умолчанию. Он же - законный ответ мастера «не обсуждали»: если разговор не
// состоялся или клиент ответил неуверенно, ставится месяц, и это НЕ ошибка мастера.
// Месяц выбран не абстрактно - это шаг самой услуги, примерно столько живёт стрижка,
// и ровно эта же цифра стояла общим порогом возвращаемости (RETURN_GRACE_MONTHS = 1
// до этого окна, api/routes/analytics.js).
export const DEFAULT_RENEW_DAYS = 30;

// Границы вводимого срока. Меньше недели - это уже не «обновление стрижки», а ошибка
// ввода (мастер промахнулся мимо цифры); больше года - срок, по которому напоминать
// бессмысленно, клиент за это время сменит город.
export const RENEW_DAYS_MIN = 7;
export const RENEW_DAYS_MAX = 365;
export const RENEW_NOTE_MAX_LEN = 300;

export function isRenewReason(key) {
  return typeof key === 'string' && RENEW_REASON_KEYS.includes(key);
}

// Нормализация того, что пришло с фронта. Решение, каким срок ляжет в базу, принимает
// сервер, а не интерфейс: при причине «не обсуждали» срок ВСЕГДА месяц, что бы ни
// стояло в поле - иначе мастер мог бы выбрать «не обсуждали» и вписать любой срок,
// и метрика «доля обсуждённых» перестала бы что-либо значить.
// Возвращает { ok, value } или { ok: false, error } - HTTP-кодов здесь нет намеренно,
// функция чистая и покрыта офлайн-тестом.
export function normalizeRenewInput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'renew_required' };
  const reason = raw.reason;
  if (!isRenewReason(reason)) return { ok: false, error: 'invalid_renew_reason' };

  const asDays = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= RENEW_DAYS_MIN && n <= RENEW_DAYS_MAX ? n : null;
  };

  const days = reason === 'not_discussed' ? DEFAULT_RENEW_DAYS : asDays(raw.days);
  if (days === null) return { ok: false, error: 'invalid_renew_days' };

  // Рекомендованный срок необязателен: мастер мог назвать срок, с которым клиент сразу
  // согласился (тогда он равен согласованному и фронт его пришлёт), а мог и не
  // называть вовсе. Мусор в этом поле молча отбрасываем в null - оно копится под
  // будущую задачу и не должно ронять закрытие визита.
  const recommended = raw.recommendedDays === null || raw.recommendedDays === undefined ? null : asDays(raw.recommendedDays);

  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, RENEW_NOTE_MAX_LEN) : '';
  return { ok: true, value: { days, recommendedDays: recommended, reason, note: note || null } };
}
