// Реальный вход в боевую базу (правка Влада 28.07.2026) поверх визуального макета
// Окна 9. Переиспользует ровно тот же контракт токена/localStorage-ключей, что уже
// работает в проде в admin.js (Окно 8) - если человек уже был залогинен через старую
// admin.html, сессия подхватится и здесь без повторного входа.
import { getMasters, getServices } from '../storage.js';
import { wireNotifications } from './crm-notifications.js';
import { el } from './crm-shared.js';
import { describeError, markSessionActive, markSessionEnded, showError } from './crm-toast.js';
import { hidePageLoader, showPageLoader } from './crm-loading.js';
import { refreshRoleSnapshot, renderLiveProof } from './crm-dashboard.js';

export const API = window.ALIKHAN_API_URL;
const TOKEN_KEY = 'alikhan-crm:token';
const STAFF_KEY = 'alikhan-crm:staff';
const ROLE_LABELS = { owner: 'владелец', manager: 'управляющий', admin: 'администратор точки', master: 'мастер' };
const ROLE_PAGE = { owner: 'crm-owner.html', manager: 'crm-owner.html', admin: 'crm-admin.html', master: 'crm-master.html' };

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function getStoredStaff() {
  try {
    return JSON.parse(localStorage.getItem(STAFF_KEY) || 'null');
  } catch {
    return null;
  }
}
function setSession(token, staff) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(STAFF_KEY, JSON.stringify(staff));
  markSessionActive();
}
// Сессию закрываем не только по кнопке «Выйти»: тем же путём уходит просроченный
// токен и чужая роль на этой странице. Всё, что страница успела запросить до этого
// момента, вернётся с 401 - предупреждаем сообщения, чтобы человек на форме входа
// не читал стопку красных плашек про запросы, которых он не делал
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(STAFF_KEY);
  markSessionEnded();
}

function buildLoginGate() {
  const div = document.createElement('div');
  div.id = 'loginGate';
  div.className = 'login-gate';
  div.innerHTML = `
    <div class="login-card">
      <p class="login-kicker">CRM</p>
      <img class="login-brand-mark" src="assets/brand/lockup-footer.webp" alt="АЛИХАН - премиум мужские стрижки">
      <p class="login-tag">Вход для сотрудников</p>
      <form id="loginForm" novalidate>
        <div class="field"><label for="loginEmail">Email</label><input id="loginEmail" type="email" required autocomplete="username"></div>
        <div class="field"><label for="loginPin">PIN</label><input id="loginPin" type="password" inputmode="numeric" required autocomplete="current-password"></div>
        <p id="loginError" class="login-error" role="alert" aria-live="polite" hidden></p>
        <button class="btn btn-primary" type="submit">Войти</button>
      </form>
      <p class="login-hint">Введите рабочий email и PIN</p>
    </div>`;
  document.body.prepend(div);
  return div;
}

async function apiLogin(email, pin) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  // Раньше любой отказ на входе объяснялся «Неверный email или PIN» - и лежащий
  // сервер, и пропавшая сеть выглядели как ошибка в наборе PIN. Теперь причина
  // берётся из ответа: 401 так и останется про email и PIN, 503 скажет про сервер
  if (!res.ok) throw await requestError(res, '/auth/login');
  return res.json();
}

// Ошибка запроса, которую не стыдно показать человеку: message - готовая фраза
// («Сессия закончилась. Войдите заново»), а машинные подробности лежат отдельными
// полями. До 15.08.2026 message был `/staff → 500`, и десяток экранов печатал это
// прямо в интерфейс - Влад справедливо назвал такое «просто код какой-то»
async function requestError(res, path) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    // тело может быть пустым или не-JSON - причину тогда берём из статуса
  }
  const error = new Error(describeError({ status: res.status, data }) ?? `${path} → ${res.status}`);
  error.code = data?.error ?? null;
  error.status = res.status;
  error.path = path;
  return error;
}

export async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw await requestError(res, path);
  return res.json();
}

// Окно 18 (04.08.2026) - общий helper для POST/PUT/DELETE с тем же токеном, что уже
// использует fetchJson (GET) - Неделя/Месяц/Год (assets/crm-schedule-views.js) не
// дублируют логику Authorization-заголовка. Возвращает {ok, status, data} - вызывающий
// код сам решает, что делать с 409/403/etc (разные экраны показывают конфликт по-разному).
export async function apiSend(path, method, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // тело может быть пустым (например 204) - не считается ошибкой парсинга
  }
  return { ok: res.ok, status: res.status, data };
}

export function initCrmAuth(requiredRole) {
  const requiredRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
  const gate = buildLoginGate();
  const main = el('crmMain');
  const sessionInfo = el('sessionInfo');
  const logoutBtn = el('logoutBtn');

  function reveal(staff) {
    gate.hidden = true;
    if (main) main.hidden = false;
    if (sessionInfo) sessionInfo.textContent = `${staff.name} · ${ROLE_LABELS[staff.role] ?? staff.role}`;
    if (logoutBtn) logoutBtn.hidden = false;
    // У сотрудника в базе ровно одна роль. В topbar она показана статичной меткой,
    // а не ссылкой на соседний кабинет: переход на страницу чужой роли намеренно
    // очищает несовместимую сессию, поэтому такого ложного действия в UI быть не должно.
    document.querySelectorAll('#roleSwitch [data-role]').forEach((indicator) => {
      const isManagementIndicator = indicator.dataset.role === 'owner' && staff.role === 'manager';
      indicator.hidden = !(indicator.dataset.role === staff.role || isManagementIndicator);
      if (isManagementIndicator) indicator.textContent = 'Управляющий';
    });
    window.__refreshRoleSnapshot = () => refreshRoleSnapshot(staff);
    // Между входом и готовым рабочим столом идёт несколько запросов подряд - до этой
    // правки (Влад, 15.08.2026) человек всё это время смотрел на полупустой каркас с
    // надписями «Загружаю…». Экран снимаем, когда первичная загрузка данных
    // закончилась - и при удаче, и при отказе: висеть вечно он не должен
    showPageLoader();
    Promise.resolve(renderLiveProof(staff)).finally(hidePageLoader);
    wireNotifications(staff);
    document.dispatchEvent(new CustomEvent('crm:authenticated', { detail: staff }));
  }

  // Баг (найден Владом 02.08.2026): заход на crm-master.html с уже сохранённой в
  // браузере сессией владельца молча показывал владельца вместо формы входа -
  // "перекидывает в окно владельца" при попытке зайти в аккаунт мастера. Причина -
  // staff.role !== 'owner' ниже пропускал владельца мимо проверки роли страницы.
  // Различаем два случая: свежий логин (fromLogin=true, сразу после сабмита формы)
  // уводит на СВОЮ страницу по роли - это рабочий путь входа мастера/админа через
  // единственную публичную ссылку "Вход для сотрудников" (ведёт на crm-owner.html),
  // не трогаем. Восстановление СТАРОЙ сессии другой роли на чужой странице
  // (fromLogin не передан) больше не подставляет чужие данные и не молчит - чистит
  // сессию и показывает форму входа прямо на этой странице, чтобы можно было
  // сразу ввести данные нужной роли.
  function handleStaff(staff, fromLogin) {
    if (!requiredRoles.includes(staff.role)) {
      if (fromLogin) {
        location.href = ROLE_PAGE[staff.role] || 'crm-owner.html';
      } else {
        clearSession();
        gate.hidden = false;
      }
      return;
    }
    reveal(staff);
  }

  el('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = el('loginEmail').value.trim();
    const pin = el('loginPin').value.trim();
    const errEl = el('loginError');
    errEl.hidden = true;
    try {
      const data = await apiLogin(email, pin);
      setSession(data.token, data.staff);
      handleStaff(data.staff, true);
    } catch (err) {
      // Форма входа стоит по центру экрана - её собственной строки ошибки достаточно,
      // всплывающее сообщение здесь только дублировало бы то же самое
      errEl.textContent = describeError(err) ?? 'Не удалось войти. Повторите попытку';
      errEl.hidden = false;
    }
  });

  logoutBtn?.addEventListener('click', () => {
    clearSession();
    location.reload();
  });

  if (main) main.hidden = true;
  const existing = getStoredStaff();
  if (existing && getToken()) {
    fetchJson('/auth/me').then((data) => {
      setSession(getToken(), data.staff);
      handleStaff(data.staff);
    }).catch((err) => {
      // Просроченная сессия - штатный случай, человек просто входит заново. А вот
      // лежащий сервер или пропавшая сеть выглядели точно так же (форма входа без
      // объяснений) - теперь причина видна сообщением внизу экрана
      if (err?.status !== 401) showError(describeError(err) ?? 'Не удалось проверить сессию. Войдите заново');
      clearSession();
      gate.hidden = false;
    });
  } else {
    gate.hidden = false;
  }
}

// Реэкспорт для отладки в консоли из макета, если понадобится (не используется UI).
window.__crmAuthDebug = { getMasters, getServices };
