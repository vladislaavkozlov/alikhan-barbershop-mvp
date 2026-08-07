// Общая HTTP-инфраструктура (CORS, JSON-ответ, чтение тела запроса) - вынесено из
// server.mjs при декомпозиции (Этап 2 структурного рефакторинга, 07.08.2026), код
// перенесён без изменений.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
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
