// Плавающие сообщения внизу экрана - один шаблон для ВСЕХ ролей и всех страниц CRM
// (владелец/управляющий, администратор, мастер). Правка Влада 15.08.2026: строка
// статуса живёт внизу карточки, а карточки длинные - поле подсвечивалось красным,
// а до текста ошибки приходилось листать и листать. Теперь любое сообщение всплывает
// над содержимым в том же углу, где плавает кнопка "Свернуть все", и не уезжает со
// скроллом. Ошибку убирает только человек (крестик), успех гаснет сам.
//
// Модуль монтируется один раз из crm-auth.js (общая точка входа всех трёх страниц),
// поэтому отдельного подключения на каждой странице не нужно.

const AUTO_HIDE_MS = 4000;
let host = null;

// Коды ошибок сервера человеческим языком. Тексты сверены с реальными проверками в
// api/routes/*.js - в них не должно быть выдуманных лимитов и правил (PIN шесть цифр
// - auth.js, комментарий 500 знаков - bookings.js, портфолио 20 фото - staff-media.js)
const ERROR_TEXT = {
  unauthorized: 'Сессия закончилась. Войдите заново',
  forbidden: 'У вашей роли нет прав на это действие',
  route_not_found: 'Такого раздела на сервере нет - обновите страницу',
  internal_error: 'Сервер не смог обработать запрос. Попробуйте ещё раз',
  missing_fields: 'Заполнены не все обязательные поля',

  invalid_credentials: 'Неверный email или PIN',
  email_and_pin_required: 'Введите email и PIN',
  invalid_pin: 'PIN должен быть из шести цифр',
  email_in_use: 'Этот email уже занят другим сотрудником',

  staff_not_found: 'Сотрудник не найден - возможно, его уже удалили',
  unknown_master: 'Мастер не найден',
  invalid_staff_data: 'Проверьте имя, email и роль сотрудника',
  invalid_role: 'Такой роли не существует',
  protected_owner: 'Карточку владельца изменить нельзя',
  last_owner_role_locked: 'Это единственный владелец - снять с него роль нельзя',
  invalid_master_ids: 'Список мастеров передан неверно',

  service_not_found: 'Услуга не найдена в каталоге',
  unknown_master_service: 'У этого мастера такая услуга не настроена',
  invalid_duration: 'Длительность услуги должна быть больше 0 минут',

  booking_not_found: 'Запись не найдена - возможно, её уже удалили',
  booking_cancelled: 'Запись отменена, изменить её уже нельзя',
  schedule_conflict: 'На это время уже есть запись',
  invalid_status: 'Такого статуса визита не существует',
  invalid_actual_price: 'Сумма должна быть числом и не может быть отрицательной',
  invalid_comment: 'Комментарий передан неверно',
  comment_too_long: 'Комментарий длиннее 500 знаков',
  client_not_found: 'Клиент не найден',
  invalid_client_name: 'Имя клиента передано неверно',
  client_name_too_long: 'Имя клиента длиннее 120 знаков',
  invalid_client_phone: 'Телефон введён не полностью - нужен номер целиком или пустое поле',
  combo_conflict: 'Комплекс уже включает эту услугу - оставьте либо комплекс, либо её отдельно',

  shift_not_found: 'Смена не найдена',
  invalid_range: 'Проверьте даты: начало должно быть раньше конца',
  invalid_year: 'Неверный год',
  missing_time: 'Укажите время',
  invalid_weekly_changes: 'Проверьте время: конец рабочего дня должен быть позже начала, а перерыв - внутри рабочего дня',
  invalid_schedule_exception: 'Проверьте даты и время разового изменения',
  cannot_cancel_weekly: 'Это рабочая неделя, а не разовое изменение - её отменяют в графике',

  request_not_found: 'Заявка не найдена',
  invalid_request_type: 'Такого типа заявки не существует',
  invalid_category: 'Такой категории заявки не существует',
  invalid_decision: 'Решение по заявке передано неверно',
  already_decided: 'По этой заявке уже принято решение',
  already_cancelled: 'Заявка уже отменена',
  not_approved: 'Заявка ещё не одобрена',

  media_not_found: 'Фотография не найдена',
  invalid_media_kind: 'Такой тип файла загрузить нельзя',
  invalid_media_order: 'Порядок фотографий передан неверно',
  portfolio_limit: 'В портфолио уже 20 фотографий - удалите лишние',

  invalid_id: 'Неверный идентификатор',
};

// Ответ без кода (сеть отвалилась, сервер отдал HTML) - объясняем по HTTP-статусу,
// а не показываем голое число
const STATUS_TEXT = {
  0: 'Нет связи с сервером. Проверьте интернет',
  400: 'Сервер не принял данные - проверьте заполненные поля',
  401: 'Сессия закончилась. Войдите заново',
  403: 'У вашей роли нет прав на это действие',
  404: 'Данные не найдены - возможно, их уже удалили',
  409: 'Данные успели измениться в другом месте. Обновите страницу',
  413: 'Файл слишком большой',
  500: 'Сервер не смог обработать запрос. Попробуйте ещё раз',
  502: 'Сервер перезапускается. Повторите через минуту',
  503: 'Сервер перезапускается. Повторите через минуту',
};

export function errorTextByCode(code) {
  return ERROR_TEXT[code] ?? null;
}

// Причина ошибки человеческим языком из чего угодно: ответа apiSend ({status, data}),
// брошенного fetchJson Error (у него есть .code и .status), кода строкой или обычного
// текста. Возвращает null, когда сказать нечего - тогда вызывающий код покажет только
// свою общую фразу, без хвоста вида "→ 500"
export function describeError(input) {
  if (!input) return null;
  if (typeof input === 'string') return ERROR_TEXT[input] ?? input;
  const code = input.code ?? input.data?.error ?? input.error;
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
  const status = input.status ?? input.data?.status;
  if (status && STATUS_TEXT[status]) return STATUS_TEXT[status];
  if (input instanceof Error) {
    // Браузер обрывает fetch на пропавшей сети своим техническим текстом
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(input.message)) return STATUS_TEXT[0];
    // "/staff → 500", "HTTP 409" - технические тексты, которыми модули CRM бросают
    // ошибку запроса. Наружу такое не показываем: человеку нужен смысл статуса
    const httpTail = input.message.match(/(?:→\s*|HTTP\s*)(\d{3})\b/);
    if (httpTail) return STATUS_TEXT[Number(httpTail[1])] ?? null;
    return input.message || null;
  }
  return null;
}

// "Не удалось сохранить" + причина, если она известна. Без prefix (когда текст уже
// написан для человека - "Укажите дату") фраза уходит на экран как есть, без обёртки
export function errorMessage(input, prefix) {
  const reason = describeError(input);
  if (!prefix) return reason ?? 'Не удалось выполнить действие. Повторите попытку';
  return reason ? `${prefix}: ${reason}` : `${prefix}. Повторите попытку`;
}

function ensureHost() {
  if (host?.isConnected) return host;
  host = document.createElement('div');
  host.className = 'crm-toasts';
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', 'Сообщения');
  document.body.append(host);
  return host;
}

function iconFor(type) {
  if (type === 'success') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  if (type === 'info') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.9"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
}

export function dismissToasts() {
  host?.querySelectorAll('.crm-toast').forEach((toast) => toast.remove());
}

// Конец сессии (токен истёк, вход под другой ролью, выход) обрывает разом все
// запросы, которые страница уже успела отправить - каждый возвращается своим 401 и
// печатает своё красное сообщение. Влад увидел это 15.08.2026 при входе в кабинет:
// над расписанием висели «Не удалось загрузить рабочую неделю» и «...разовые
// изменения», хотя человек ничего не запускал, а причина одна и уже на экране -
// перед ним форма входа. После markSessionEnded() ошибки не показываем и убираем
// уже висящие; markSessionActive() при успешном входе возвращает всё как было
let sessionEnded = false;
export function markSessionEnded() {
  sessionEnded = true;
  host?.querySelectorAll('.crm-toast--error').forEach((toast) => toast.remove());
}
export function markSessionActive() {
  sessionEnded = false;
}
export function isSessionEnded() {
  return sessionEnded;
}

// text - готовая фраза для человека. Одинаковое сообщение не размножается: повторный
// вызов оживляет уже висящий тост, иначе экран забивается копиями при повторных
// нажатиях на ту же кнопку
export function showToast(text, { type = 'error', timeout } = {}) {
  const message = String(text ?? '').trim();
  if (!message) return null;
  // Сессии нет - показывать нечего: причина у всех отказов одна и человек уже видит
  // форму входа. Успех и подсказки не трогаем, они про другое
  if (type === 'error' && sessionEnded) return null;
  const parent = ensureHost();

  const existing = [...parent.querySelectorAll('.crm-toast')].find((t) => t.dataset.message === message && t.dataset.type === type);
  if (existing) {
    existing.classList.remove('crm-toast--pulse');
    void existing.offsetWidth;
    existing.classList.add('crm-toast--pulse');
    scheduleHide(existing, type, timeout);
    return existing;
  }

  const toast = document.createElement('div');
  toast.className = `crm-toast crm-toast--${type}`;
  toast.dataset.message = message;
  toast.dataset.type = type;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `<span class="crm-toast__icon" aria-hidden="true">${iconFor(type)}</span><p class="crm-toast__text"></p><button class="crm-toast__close" type="button" aria-label="Закрыть сообщение">×</button>`;
  toast.querySelector('.crm-toast__text').textContent = message;
  toast.querySelector('.crm-toast__close').addEventListener('click', () => toast.remove());
  parent.append(toast);
  scheduleHide(toast, type, timeout);
  return toast;
}

// Ошибка висит, пока её не закроют: человек мог отойти от экрана, а причина отказа -
// это то, ради чего сообщение вообще показано. Успех и подсказки гаснут сами
function scheduleHide(toast, type, timeout) {
  clearTimeout(Number(toast.dataset.timerId));
  const ms = timeout ?? (type === 'error' ? 0 : AUTO_HIDE_MS);
  if (!ms) return;
  toast.dataset.timerId = String(setTimeout(() => toast.remove(), ms));
}

export function showError(text) {
  return showToast(text, { type: 'error' });
}
export function showSuccess(text) {
  return showToast(text, { type: 'success' });
}
export function showInfo(text) {
  return showToast(text, { type: 'info' });
}

// Главный хелпер для мест, где уже есть своя строка статуса: пишет туда тот же текст,
// что и во всплывающее сообщение, - у экрана остаётся привязка к конкретной карточке,
// а человек видит причину, не листая
export function reportError(noteEl, input, prefix) {
  const text = errorMessage(input, prefix);
  if (noteEl) noteEl.textContent = text;
  showError(text);
  return text;
}

export function reportSuccess(noteEl, text) {
  if (noteEl) noteEl.textContent = text;
  showSuccess(text);
  return text;
}
