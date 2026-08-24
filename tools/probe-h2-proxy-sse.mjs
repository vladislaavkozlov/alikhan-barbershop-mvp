// Стенд для разбора инцидента 24.08.2026 (поток событий блокирует следующий запрос).
//
// На проде между браузером и Node стоит прокси Envoy: снаружи HTTP/2, к приложению -
// HTTP/1.1. Локально этой связки нет, поэтому инцидент не воспроизводился. Здесь она
// собирается руками: HTTP/2-прокси с настраиваемым пулом соединений к приложению.
//
// Что выясняем: виснет ли запрос, отправленный по тому же соединению, пока живёт
// поток событий, - и при каком размере пула это начинается.
//
// Запуск: node tools/probe-h2-proxy-sse.mjs [размер-пула]
import http2 from 'node:http2';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SOCKETS = Number(process.argv[2] ?? 1);
const APP_PORT = 9111;
const PROXY_PORT = 9112;
const ORIGIN = 'https://localhost:' + PROXY_PORT;

const app = spawn(process.execPath, [join(ROOT, 'api', 'server.mjs')], {
  env: {
    ...process.env, PORT: String(APP_PORT), DB_HOST: '/tmp', DB_NAME: 'tenant_cabinets_probe',
    DB_USER: 'probe_cab_app', DB_PASSWORD: 'probe', DB_SSL: 'disable', LIVE_EVENTS: 'on',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/health`)).ok) break; } catch { /* поднимается */ }
  await new Promise((r) => setTimeout(r, 100));
}

// Тот самый узел: снаружи HTTP/2, к приложению HTTP/1.1 через пул ограниченного размера
const agent = new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS });
const proxy = http2.createSecureServer({
  key: readFileSync('/tmp/probe-key.pem'),
  cert: readFileSync('/tmp/probe-cert.pem'),
});
proxy.on('stream', (stream, headers) => {
  const upstream = http.request(
    {
      host: '127.0.0.1', port: APP_PORT, path: headers[':path'], method: headers[':method'] ?? 'GET', agent,
      headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith(':'))),
    },
    (res) => {
      stream.respond({ ':status': res.statusCode, ...Object.fromEntries(Object.entries(res.headers).filter(([k]) => !['connection','transfer-encoding','keep-alive'].includes(k))) });
      res.on('data', (c) => stream.write(c));
      res.on('end', () => stream.end());
    }
  );
  upstream.on('error', () => stream.close());
  stream.on('data', (c) => upstream.write(c));
  stream.on('end', () => upstream.end());
  if (headers[':method'] === 'GET') upstream.end();
});
await new Promise((r) => proxy.listen(PROXY_PORT, r));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const client = http2.connect(`https://localhost:${PROXY_PORT}`, { rejectUnauthorized: false });

const login = await new Promise((resolve) => {
  const req = client.request({ ':method': 'POST', ':path': '/auth/login', 'content-type': 'application/json', origin: 'http://localhost:8793' });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => resolve(JSON.parse(body)));
  req.end(JSON.stringify({ email: 'owner@alikhan.local', pin: '1234' }));
});

const call = (path, { stream = false } = {}) =>
  new Promise((resolve) => {
    const started = Date.now();
    const req = client.request({ ':path': path, origin: 'http://localhost:8793', authorization: `Bearer ${login.token}` });
    let status = null;
    const timer = setTimeout(() => resolve({ итог: 'ТАЙМАУТ 8с', req }), 8000);
    req.on('response', (h) => {
      status = h[':status'];
      if (stream) { clearTimeout(timer); resolve({ итог: `поток открыт (${status})`, req }); }
    });
    req.on('data', () => {});
    req.on('end', () => { clearTimeout(timer); resolve({ итог: `${status} за ${Date.now() - started}мс` }); });
    req.on('error', (e) => { clearTimeout(timer); resolve({ итог: 'ошибка ' + e.message }); });
    req.end();
  });

console.log(`Стенд: HTTP/2 снаружи → HTTP/1.1 к приложению, пул соединений = ${MAX_SOCKETS}`);
console.log('  до потока:        ', (await call('/staff')).итог);
const sse = await call('/events', { stream: true });
console.log('  поток событий:    ', sse.итог);
console.log('  первый при потоке:', (await call('/staff')).итог);
console.log('  второй при потоке:', (await call('/services')).итог);
sse.req?.close();
await new Promise((r) => setTimeout(r, 300));
console.log('  после закрытия:   ', (await call('/staff')).итог);

client.close();
proxy.close();
app.kill('SIGTERM');
