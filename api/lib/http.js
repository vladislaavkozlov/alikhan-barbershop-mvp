// Общая HTTP-инфраструктура (CORS, JSON-ответ, чтение тела запроса) - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
// Ловушка 7 спеки (24.08.2026): раньше разрешённый источник был один и приезжал из
// переменной окружения ALLOWED_ORIGIN - при домене на каждого арендатора этого мало.
// Теперь источник приходит аргументом: его вычисляет lib/tenants.js по доменам
// арендатора, которому адресован запрос. null означает «источник не разрешён» -
// заголовок не ставится вовсе, и браузер блокирует ответ сам.
export function setCors(res, allowedOrigin) {
  // Ответ теперь зависит от источника запроса: без этого заголовка промежуточный кэш
  // мог бы отдать кабинету одного арендатора ответ, разрешённый для домена другого
  res.setHeader('Vary', 'Origin');
  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  // Окно 18 (04.08.2026) - найден живым тестом: DELETE /schedule (задача 2 промпта
  // Окна 17) не работал из браузера ("Failed to fetch" на кнопке "Сбросить к
  // стандартному") - метод существовал на сервере, но отсутствовал в CORS-preflight
  // ответе, браузер блокировал реальный запрос ДО того как он вообще уходил на
  // сервер. Добавлен DELETE - упущение Окна 17 при добавлении маршрута, не новая
  // функциональность.
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export async function readRawBody(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) { const error = new Error('payload_too_large'); error.code = 'payload_too_large'; throw error; } chunks.push(chunk); }
  return Buffer.concat(chunks);
}

// ── Ответ уходит только после фиксации транзакции ──────────────────────────
// Найдено живым прогоном 24.08.2026: сервер отвечал «запись создана», а прочитать её
// сразу после ответа удавалось не всегда. Причина не в потере данных, а в порядке:
// с транзакцией на запрос (Фаза 1 мультиарендности) обработчик отправляет ответ
// ВНУТРИ транзакции, а COMMIT происходит после. Между ними есть окно, в котором
// клиент уже получил «готово», а данных в базе ещё нет.
//
// Чем это плохо на проде: кабинет получает 200 и тут же перечитывает список - и не
// видит только что созданной записи. А если COMMIT ещё и упадёт, человек останется с
// подтверждением записи, которой нет.
//
// Поэтому ответ копится в буфере и уходит одним куском после успешного COMMIT. Если
// транзакция откатилась - буфер выбрасывается, человек получает честную ошибку, а не
// подтверждение несуществующей записи.
export function createBufferedResponse(res) {
  const calls = [];
  const buffered = {
    headersSent: false,
    setHeader: (name, value) => res.setHeader(name, value),
    getHeader: (name) => res.getHeader(name),
    removeHeader: (name) => res.removeHeader(name),
    writeHead(status, headers) {
      buffered.headersSent = true;
      calls.push(['writeHead', status, headers]);
      return buffered;
    },
    write(chunk) {
      calls.push(['write', chunk]);
      return true;
    },
    end(chunk) {
      calls.push(['end', chunk]);
      return buffered;
    },
    on: (...args) => res.on(...args),
    once: (...args) => res.once(...args),
    emit: (...args) => res.emit(...args),
  };
  return {
    res: buffered,
    get answered() {
      return calls.length > 0;
    },
    flush() {
      for (const [method, ...args] of calls) {
        if (method === 'writeHead') res.writeHead(args[0], args[1]);
        else if (method === 'write') res.write(args[0]);
        else res.end(args[0]);
      }
      calls.length = 0;
    },
    discard() {
      calls.length = 0;
    },
  };
}
