// Живое обновление кабинетов (17.08.2026, задача Влада: «запись при создании должна
// появляться в расписании моментально без обновлений... бесшовно и мгновенно, для
// заказчика это критично» + «сделай так, чтобы без каких-либо действий работало» про
// чужие правки настроек).
//
// До этого дня единственным способом увидеть чужое изменение была кнопка «Обновить»:
// живой замер 17.08.2026 (tools/diag-2026-08-17-zhivoe-obnovlenie.mjs) показал, что
// открытый кабинет не замечает новую запись и через 15 секунд, а по кнопке видит сразу.
//
// Механизм - поток событий от сервера к каждому открытому кабинету (SSE-совместимый
// формат `data: {...}\n\n`). Сервер ничего не спрашивает у браузера: как только
// изменились брони, график, команда или уведомления, всем подключённым уходит короткая
// строчка, и кабинет сам перечитывает ровно тот кусок, которого касается событие.
//
// Почему свой реестр, а не готовая библиотека: в проекте нет сборщика и внешних
// зависимостей у API (только pg), а вся задача - это Set из res-объектов и цикл записи.
//
// ВАЖНО про Amvera: между браузером и Node стоит прокси, и молчащее соединение он
// может закрыть. Поэтому раз в HEARTBEAT_MS в поток уходит комментарий `: ping` -
// он не виден потребителю как событие, но держит канал живым. Если прокси всё равно
// оборвёт - фронт (assets/crm-live.js) переподключится сам, а на совсем безнадёжный
// случай там же лежит фолбэк на опрос GET /changes.

const HEARTBEAT_MS = 20000;

// Кто сейчас слушает. Ключ - сам res, значение - что о подписчике известно
const subscribers = new Map();

let heartbeat = null;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const res of subscribers.keys()) {
      try {
        res.write(': ping\n\n');
      } catch {
        dropSubscriber(res);
      }
    }
  }, HEARTBEAT_MS);
  // Таймер не должен держать процесс живым сам по себе
  heartbeat.unref?.();
}

function stopHeartbeatIfIdle() {
  if (subscribers.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function dropSubscriber(res) {
  subscribers.delete(res);
  stopHeartbeatIfIdle();
  try {
    res.end();
  } catch {
    // соединение уже разорвано - ничего не делаем
  }
}

// Подписать открытый кабинет. auth - результат authenticate(), нужен чтобы не слать
// сотруднику события чужой точки и чтобы уведомления уходили адресно
export function addSubscriber(req, res, auth) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Отдельная страховка от буферизации на промежуточном nginx: без неё поток
    // копится в буфере прокси и доходит пачкой, что убивает весь смысл затеи
    'X-Accel-Buffering': 'no',
  });
  // Первая строчка уходит сразу - она же подтверждает браузеру, что канал открыт
  res.write('retry: 3000\n');
  res.write(`data: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`);

  subscribers.set(res, { staffId: auth.id, role: auth.role, locationId: auth.locationId });
  startHeartbeat();

  req.on('close', () => dropSubscriber(res));
  req.on('error', () => dropSubscriber(res));
}

// Разослать событие. audience - необязательный фильтр:
//   { staffId } - только этому сотруднику (личные уведомления)
//   { locationId } - только тем, кто работает на этой точке
// Без фильтра событие уходит всем подключённым.
//
// Функция намеренно синхронная и не бросает: она вызывается ПОСЛЕ успешной записи в
// базу, и упавшая рассылка не должна превращать успешный ответ роута в 500. Тихо
// выкидываем оборванные соединения и идём дальше.
export function broadcast(type, payload = {}, audience = null) {
  if (subscribers.size === 0) return 0;
  const line = `data: ${JSON.stringify({ type, ...payload, at: new Date().toISOString() })}\n\n`;
  let sent = 0;
  for (const [res, who] of subscribers.entries()) {
    if (audience?.staffId && who.staffId !== audience.staffId) continue;
    if (audience?.locationId != null && who.locationId !== audience.locationId) continue;
    try {
      res.write(line);
      sent++;
    } catch {
      dropSubscriber(res);
    }
  }
  return sent;
}

// Для GET /changes - фолбэка на случай, если поток не доживает до браузера. Держим
// счётчик и время последнего изменения по каждому виду данных: кабинет опрашивает
// этот роут раз в несколько секунд и сравнивает со своим прошлым ответом
const lastChange = { bookings: 0, schedule: 0, staff: 0, notifications: 0 };

export function markChanged(type) {
  if (type in lastChange) lastChange[type] = Date.now();
}

export function changesSnapshot() {
  return { ...lastChange };
}

// Одна точка входа для роутов: пометить изменение и разослать его. Всё, что меняет
// данные, зовёт именно её - тогда фолбэк-счётчик и поток не могут разъехаться
export function publish(type, payload = {}, audience = null) {
  markChanged(type);
  return broadcast(type, payload, audience);
}

export function subscriberCount() {
  return subscribers.size;
}
