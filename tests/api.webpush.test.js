// Уведомления на телефон: шифрование и подпись (Окно 73, 28.08.2026).
//
// Почему эти проверки важнее обычных. Здесь нет способа «посмотреть глазами»: если
// ключи выведены неправильно, сервис доставки примет запрос и ответит успехом, а
// телефон молча ничего не покажет - ошибка проявится только у живого человека и
// без всякого сообщения. Поэтому протокол проверяется здесь целиком.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import {
  b64url,
  fromB64url,
  decryptPayload,
  encryptPayload,
  generateVapidKeys,
  vapidHeaders,
} from '../api/lib/webpush.js';

// Играем роль браузера: своя пара ключей и секрет подписки, ровно как их отдаёт
// pushManager.subscribe() в настоящем телефоне
function fakeDevice() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, auth: randomBytes(16), p256dh: b64url(ecdh.getPublicKey()) };
}

test('зашифрованное нами читается ключом устройства - и наоборот не читается чужим', () => {
  const device = fakeDevice();
  const text = 'Новая запись: Ренат, завтра 15:00';
  const body = encryptPayload(text, device.p256dh, b64url(device.auth));

  // Расшифровка идёт с ПРОТИВОПОЛОЖНОЙ стороны обмена: приватный ключ устройства
  // против нашего публичного. Ошибись мы в порядке склейки или в выводе ключей -
  // стороны получили бы разные ключи и здесь всё развалилось бы
  assert.equal(decryptPayload(body, device.ecdh.getPrivateKey(), device.auth), text);

  // Другое устройство того же вида прочитать не должно
  const stranger = fakeDevice();
  assert.throws(() => decryptPayload(body, stranger.ecdh.getPrivateKey(), stranger.auth));
});

test('секрет подписки участвует в выводе ключей, а не просто лежит рядом', () => {
  const device = fakeDevice();
  const body = encryptPayload('текст', device.p256dh, b64url(device.auth));
  // Тот же приватный ключ, но чужой секрет - расшифровка обязана провалиться.
  // Это ловит ошибку «забыли подмешать auth», при которой всё внешне работает
  assert.throws(() => decryptPayload(body, device.ecdh.getPrivateKey(), randomBytes(16)));
});

test('тело письма собрано по формату: соль, размер записи, наш публичный ключ', () => {
  const device = fakeDevice();
  const body = encryptPayload('текст', device.p256dh, b64url(device.auth));
  assert.equal(body.length > 16 + 4 + 1 + 65, true, 'тело короче обязательного заголовка');
  assert.equal(body.readUInt32BE(16), 4096, 'размер записи не на своём месте');
  assert.equal(body[20], 65, 'длина публичного ключа должна быть 65 байт (несжатый вид)');
  assert.equal(body[21], 4, 'публичный ключ должен начинаться с признака несжатого вида');
});

test('каждое письмо шифруется своей солью - два одинаковых текста не совпадают побайтно', () => {
  const device = fakeDevice();
  const a = encryptPayload('один и тот же текст', device.p256dh, b64url(device.auth));
  const b = encryptPayload('один и тот же текст', device.p256dh, b64url(device.auth));
  assert.notEqual(a.toString('base64'), b.toString('base64'));
  // но оба читаются
  assert.equal(decryptPayload(a, device.ecdh.getPrivateKey(), device.auth), 'один и тот же текст');
  assert.equal(decryptPayload(b, device.ecdh.getPrivateKey(), device.auth), 'один и тот же текст');
});

test('подпись отправителя проверяется его же публичным ключом', () => {
  const keys = generateVapidKeys();
  const headers = vapidHeaders({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject: 'mailto:test@example.com',
  });
  const token = headers.Authorization.match(/t=([^,]+)/)[1];
  const [head, payload, signature] = token.split('.');

  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64').toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(payload, 'base64').toString());
  // Адресат - сервис доставки, а не сотрудник: только происхождение адреса, без пути
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:test@example.com');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'подпись выписана уже просроченной');
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 24 * 60 * 60, 'слишком долгий срок жизни подписи');

  const der = Buffer.concat([
    Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
    fromB64url(keys.publicKey),
  ]);
  const pub = createPublicKey({ key: der, format: 'der', type: 'spki' });
  assert.equal(
    verify('sha256', Buffer.from(`${head}.${payload}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64url(signature)),
    true,
    'подпись не проверяется своим же ключом',
  );
  assert.ok(headers.Authorization.includes(`k=${keys.publicKey}`), 'публичный ключ не приложен к письму');
});

test('адресат подписи берётся из адреса устройства, а не зашит намертво', () => {
  const keys = generateVapidKeys();
  const apple = vapidHeaders({
    endpoint: 'https://web.push.apple.com/QWERTY',
    publicKey: keys.publicKey, privateKey: keys.privateKey, subject: 'mailto:t@e.com',
  });
  const claims = JSON.parse(Buffer.from(apple.Authorization.match(/t=([^.]+)\.([^.]+)/)[2], 'base64').toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
});

test('ключи отправителя генерируются в том виде, который принимает браузер', () => {
  const keys = generateVapidKeys();
  assert.equal(fromB64url(keys.publicKey).length, 65, 'публичный ключ должен быть 65 байт');
  assert.equal(fromB64url(keys.publicKey)[0], 4, 'ключ должен быть в несжатом виде');
  assert.equal(fromB64url(keys.privateKey).length, 32, 'приватный ключ должен быть 32 байта');
  assert.doesNotMatch(keys.publicKey, /[+/=]/, 'ключ должен быть в безопасном для адреса виде');
});
