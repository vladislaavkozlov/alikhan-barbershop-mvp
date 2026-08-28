// Отправка push-уведомлений на телефоны сотрудников (Окно 73, 28.08.2026).
//
// Зачем свой код, а не библиотека. У этого API нет зависимостей, кроме pg - так
// заведено в проекте, и npm install в рабочем окружении ненадёжен. Всё, что нужно
// для web push, есть во встроенном node:crypto: ECDH на P-256, HKDF через HMAC,
// AES-128-GCM и подпись ES256. Поэтому протокол реализован здесь напрямую.
//
// Что происходит при отправке. Браузер сотрудника дал нам три вещи: адрес своего
// почтового ящика у Google или Apple (endpoint), свой публичный ключ (p256dh) и
// секрет (auth). Мы шифруем текст уведомления так, что расшифровать его может
// только этот браузер - ни Google, ни Apple содержимое не видят, они лишь
// доставляют запечатанный конверт. Отдельно письмо подписывается нашим ключом
// (VAPID), чтобы сервис доставки знал, что отправитель - это наш сервер.
//
// Стандарты: RFC 8291 (шифрование), RFC 8292 (подпись отправителя).
import { createECDH, createHmac, createCipheriv, createDecipheriv, randomBytes, createPrivateKey, sign as signRaw } from 'node:crypto';

const CURVE = 'prime256v1';

export const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (str) => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// HKDF из RFC 5869 в том сокращённом виде, в каком его использует web push:
// длина результата всегда меньше 32 байт, поэтому хватает одного витка.
function hkdf(salt, ikm, info, length) {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

// Ключи отправителя. Публичную половину браузер получает при подписке и
// запоминает: письма, подписанные другим ключом, он потом отвергнет.
export function generateVapidKeys() {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

// Приватный ключ у нас лежит 32 байтами (так его отдаёт generateVapidKeys и так
// его принято хранить), а node для подписи хочет полноценный ключ - собираем его
// через минимальную DER-обёртку PKCS#8.
function privateKeyFromRaw(rawPrivate, rawPublic) {
  const der = Buffer.concat([
    Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex'),
    rawPrivate,
    Buffer.from('a144034200', 'hex'),
    rawPublic,
  ]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function publicFromPrivateRaw(rawPrivate) {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(rawPrivate);
  return ecdh.getPublicKey();
}

// Подпись отправителя (RFC 8292): обычный JWT, подписанный ES256. Живёт 12 часов,
// адресован сервису доставки, а не сотруднику.
export function vapidHeaders({ endpoint, publicKey, privateKey, subject }) {
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  }));
  const rawPrivate = fromB64url(privateKey);
  const key = privateKeyFromRaw(rawPrivate, publicFromPrivateRaw(rawPrivate));
  const signature = signRaw('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return {
    Authorization: `vapid t=${header}.${payload}.${b64url(signature)}, k=${publicKey}`,
  };
}

// Шифрование содержимого (RFC 8291). Возвращает готовое тело запроса.
export function encryptPayload(plaintext, clientPublicKeyB64, clientAuthB64, salt = randomBytes(16)) {
  const clientPublic = fromB64url(clientPublicKeyB64);
  const clientAuth = fromB64url(clientAuthB64);

  const server = createECDH(CURVE);
  server.generateKeys();
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(clientPublic);

  // Первый виток подмешивает секрет подписки и обе публичные половины: так ключ
  // получается уникальным для этой пары «наш сервер - это устройство».
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    clientPublic,
    serverPublic,
  ]);
  const ikm = hkdf(clientAuth, shared, keyInfo, 32);

  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 - признак последней (и единственной) записи, так требует формат.
  const padded = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, recordSize, Buffer.from([serverPublic.length]), serverPublic, body]);
}

// Одна отправка. Возвращает статус, чтобы вызывающий мог выбросить подписку,
// когда сервис доставки говорит «такого адресата больше нет» (404 или 410).
export async function sendPush(subscription, payloadText, { publicKey, privateKey, subject, ttlSeconds = 3600 } = {}) {
  const body = encryptPayload(payloadText, subscription.p256dh, subscription.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ...vapidHeaders({ endpoint: subscription.endpoint, publicKey, privateKey, subject }),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSeconds),
    },
    body,
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}

// Расшифровка тем же протоколом, но со стороны получателя - нужна тестам, чтобы
// проверить шифрование, не имея под рукой настоящего телефона. В работе сервера
// не участвует: расшифровывает всегда браузер.
//
// Ключи здесь выводятся с противоположной стороны обмена (приватный ключ
// устройства против нашего публичного), поэтому совпадение результата - не
// самоповтор, а настоящая проверка: ошибись мы в порядке склейки или в HKDF,
// стороны получили бы разные ключи и расшифровка развалилась бы.
export function decryptPayload(body, clientPrivateRaw, authSecret) {
  const salt = body.subarray(0, 16);
  const keyLength = body[20];
  const serverPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);

  const client = createECDH(CURVE);
  client.setPrivateKey(clientPrivateRaw);
  const shared = client.computeSecret(serverPublic);
  const clientPublic = client.getPublicKey();

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, serverPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  // Последний байт - признак конца записи, в текст он не входит
  return out.subarray(0, out.length - 1).toString('utf8');
}
