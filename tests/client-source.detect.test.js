// Автоопределение источника клиента на публичном сайте (17.08.2026,
// assets/client-source.js). Ответ Владу на вопрос "а определить откуда переход
// нельзя?": можно - по UTM-метке ссылки в карточке организации, иначе по referrer,
// и честно null, когда ни того ни другого нет (переход из мобильного приложения
// карт referrer часто не передаёт вовсе).
//
// Тест держит именно границу "определили / не выдумали": молчание метода - штатный
// результат, который потом руками закрывает администратор в CRM. Если однажды сюда
// приедет эвристика "в адресе есть слово maps - значит Яндекс", эти проверки упадут.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectClientSource,
  sourceFromUtm,
  sourceFromReferrer,
  clientSourceLabel,
  CLIENT_SOURCE_KEYS,
} from '../assets/client-source.js';

test('UTM: метки карт распознаются в разных написаниях', () => {
  assert.equal(sourceFromUtm('yandex_maps'), 'yandex_maps');
  assert.equal(sourceFromUtm('Yandex'), 'yandex_maps');
  assert.equal(sourceFromUtm('2gis'), '2gis');
  assert.equal(sourceFromUtm('2GIS'), '2gis');
});

test('UTM: чужая метка - не источник, а не "другое"', () => {
  assert.equal(sourceFromUtm('google_ads'), null);
  assert.equal(sourceFromUtm(''), null);
  assert.equal(sourceFromUtm(undefined), null);
});

test('referrer: веб-версия карт опознаётся по домену', () => {
  assert.equal(sourceFromReferrer('https://yandex.ru/maps/org/alikhan/1234567/'), 'yandex_maps');
  assert.equal(sourceFromReferrer('https://2gis.ru/stavropol/firm/70000001006123456'), '2gis');
  assert.equal(sourceFromReferrer('https://www.instagram.com/alikhan.barber/'), 'instagram');
  assert.equal(sourceFromReferrer('https://t.me/alikhanbarber'), 'telegram');
});

// Из приложения карт браузер отдаёт "android-app://..." или пустую строку - разбирать
// это как адрес нельзя, и гадать тоже: пусть лучше поле останется пустым.
test('referrer: приложение и мусор - молчим, а не гадаем', () => {
  assert.equal(sourceFromReferrer('android-app://ru.yandex.yandexmaps'), null);
  assert.equal(sourceFromReferrer(''), null);
  assert.equal(sourceFromReferrer('не адрес вовсе'), null);
  assert.equal(sourceFromReferrer(undefined), null);
});

// Чужой домен со словом maps в адресе не должен читаться как Яндекс Карты - правило
// идёт по домену, а не по подстроке.
test('referrer: чужой сайт со словом maps в пути - не Яндекс Карты', () => {
  assert.equal(sourceFromReferrer('https://example.com/maps/stavropol'), null);
});

test('приоритет: метка в адресе побеждает referrer', () => {
  const key = detectClientSource({
    search: '?utm_source=2gis',
    referrer: 'https://yandex.ru/maps/org/alikhan/1234567/',
  });
  assert.equal(key, '2gis');
});

test('приоритет: без метки берётся referrer, без обоих - null', () => {
  assert.equal(detectClientSource({ search: '', referrer: 'https://2gis.ru/stavropol' }), '2gis');
  assert.equal(detectClientSource({ search: '', referrer: '' }), null);
  assert.equal(detectClientSource({}), null);
});

// Подпись и ключ живут в одной таблице - иначе на карточке дня появился бы сырой
// ключ "2gis" вместо "2ГИС" (или наоборот, отчёт посчитал бы два разных канала).
test('у каждого ключа словаря есть человеческая подпись', () => {
  for (const key of CLIENT_SOURCE_KEYS) {
    assert.ok(clientSourceLabel(key), `нет подписи для ${key}`);
  }
  assert.equal(clientSourceLabel('yandex_maps'), 'Яндекс Карты');
  assert.equal(clientSourceLabel('2gis'), '2ГИС');
  assert.equal(clientSourceLabel('несуществующий'), null);
});
