// Уведомления на телефон (Окно 73, 28.08.2026).
//
// Что делает. Просит у браузера разрешение показывать уведомления, оформляет
// подписку на этом устройстве и передаёт её серверу. После этого кабинет может
// быть закрыт: телефон всё равно зазвенит, когда клиент запишется.
//
// Почему это устроено как тумблер, а не как автоматическое включение. Браузер
// показывает запрос разрешения только в ответ на действие человека - нажатие.
// Спросить «молча при загрузке» технически нельзя, а если бы и было можно, так
// делать не стоит: незапрошенный запрос почти всегда закрывают отказом, а второй
// раз браузер уже не спросит.
//
// Отдельная особенность айфонов. Apple разрешает уведомления с сайта, только если
// сайт добавлен на главный экран («Поделиться» → «На экран Домой»). Обойти это
// нельзя ничем, поэтому на айфоне в обычном Safari мы честно показываем
// инструкцию вместо тумблера, который всё равно не сработает.
import { API, apiSend, fetchJson, getToken } from './crm-auth.js';
import { errorMessage, showError, showSuccess } from './crm-toast.js';
// Слова берём из словаря вертикали: тот же движок обслуживает клинику, где «запись»
// называется приёмом. Писать их здесь руками - ровно то, что ловит
// tests/vertical-leftovers.test.js
import { P } from './crm-terms.js';

const SW_PATH = 'sw.js';

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)')?.matches === true || window.navigator.standalone === true;

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registerWorker() {
  return navigator.serviceWorker.register(SW_PATH);
}

async function currentSubscription() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function enablePush() {
  if (!supported()) throw new Error('Этот браузер не умеет показывать уведомления');
  const { configured, publicKey } = await fetchJson('/push/key');
  if (!configured || !publicKey) throw new Error('Уведомления пока не настроены на сервере');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    // Отказ браузер запоминает: повторный запрос он молча отклонит, поэтому
    // человеку нужно сказать, где это переключается вручную
    throw new Error('Уведомления запрещены в настройках браузера. Разрешите их для этого сайта и попробуйте снова');
  }

  const reg = await registerWorker();
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const json = sub.toJSON();
  const result = await apiSend('/push/subscribe', 'POST', {
    endpoint: json.endpoint,
    p256dh: json.keys?.p256dh,
    auth: json.keys?.auth,
  });
  if (!result.ok) throw new Error(errorMessage(result, 'Не удалось включить уведомления'));
  return true;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return true;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await apiSend('/push/unsubscribe', 'POST', { endpoint });
  return true;
}

// ── Карточка в кабинете ──

function card(state) {
  // Айфон вне режима «с экрана Домой» - тумблер бессмысленен, объясняем шаги
  if (state === 'ios-needs-install') {
    return `<div class="push-card" data-push-card>
      <div class="push-card-head"><strong>Уведомления на телефон</strong></div>
      <p class="note">${P('push.iosInstall')}</p>
    </div>`;
  }
  if (state === 'unsupported') {
    return `<div class="push-card" data-push-card>
      <div class="push-card-head"><strong>Уведомления на телефон</strong></div>
      <p class="note">Этот браузер не умеет показывать уведомления. Откройте кабинет в Chrome или Safari</p>
    </div>`;
  }
  if (state === 'not-configured') {
    return `<div class="push-card" data-push-card>
      <div class="push-card-head"><strong>Уведомления на телефон</strong></div>
      <p class="note">Уведомления пока не подключены на сервере</p>
    </div>`;
  }
  const on = state === 'on';
  return `<div class="push-card" data-push-card>
    <div class="push-card-head"><strong>Уведомления на телефон</strong></div>
    <p class="note">${on ? P('push.hintOn') : P('push.hintOff')}</p>
    <button class="btn ${on ? 'btn-ghost' : 'btn-primary'} btn-sm" type="button" data-push-toggle>${on ? 'Выключить' : 'Включить уведомления'}</button>
    <p class="payroll-note" data-push-note aria-live="polite"></p>
  </div>`;
}

async function resolveState() {
  if (!supported()) return isIos() && !isStandalone() ? 'ios-needs-install' : 'unsupported';
  if (isIos() && !isStandalone()) return 'ios-needs-install';
  try {
    const { configured } = await fetchJson('/push/key');
    if (!configured) return 'not-configured';
  } catch {
    return 'not-configured';
  }
  const sub = await currentSubscription();
  return sub ? 'on' : 'off';
}

async function render(host) {
  const state = await resolveState();
  host.innerHTML = card(state);
  const button = host.querySelector('[data-push-toggle]');
  if (!button) return;
  const note = host.querySelector('[data-push-note]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (state === 'on') {
        await disablePush();
        showSuccess('Уведомления на этом устройстве выключены');
      } else {
        await enablePush();
        showSuccess(P('push.enabled'));
      }
      await render(host);
    } catch (error) {
      const text = error?.message ?? 'Не удалось переключить уведомления';
      if (note) note.textContent = text;
      showError(text);
      button.disabled = false;
    }
  });
}

// Кабинет сам решает, куда поставить карточку: у владельца и администратора это
// «Личные данные», у мастера - его же раздел. Ищем контейнер по общему признаку,
// чтобы не заводить три разных вызова.
export function initPushCard(selector = '[data-push-host]') {
  const mount = () => {
    const host = document.querySelector(selector);
    if (host) render(host);
  };
  document.addEventListener('crm:authenticated', mount);
  if (getToken()) mount();
}
