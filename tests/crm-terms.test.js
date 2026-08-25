// Этап B, Фаза 2: слой применения словаря во фронте (24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// Кабинеты - статические файлы без сборки и без npm, поэтому словарь они забирают у
// сервера при старте. Здесь проверяется ровно то, что должно уцелеть в плохую погоду:
// сервер не ответил, ответил мусором, ответил с полем, которого нет.
//
// Главный тест файла - последний в первом блоке: запасные слова во фронте обязаны
// СОВПАДАТЬ со словарём сервера. Копия нужна на случай, когда сеть легла, но копия,
// которая молча разошлась с истиной, хуже отсутствующей.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { TERMS, PHRASES } from '../api/lib/vertical-terms.js';
import { MODULE_DEFAULTS } from '../api/lib/vertical-modules.js';
import {
  FALLBACK,
  loadAppearance,
  currentAppearance,
  resetAppearance,
  T,
  Tc,
  P,
  C,
  moduleEnabled,
  applyTerms,
} from '../assets/crm-terms.js';

test.beforeEach(() => resetAppearance());

// ── Запасные слова ───────────────────────────────────────────────────────────

test('запасные слова фронта совпадают со словарём сервера слово в слово', () => {
  assert.deepEqual(FALLBACK.terms, TERMS.barbershop, 'копия во фронте разошлась с истиной на сервере');
  assert.deepEqual(FALLBACK.phrases, PHRASES.barbershop);
  assert.deepEqual(FALLBACK.modules, MODULE_DEFAULTS.barbershop);
  assert.equal(FALLBACK.vertical, 'barbershop');
});

test('запасные слова моста для обычных скриптов тоже совпадают со словарём', async () => {
  // assets/mockup-crm.js подключён обычным <script> и словарь получает через window.
  // На случай, когда модуль ещё не загрузился, у него свои три слова - они обязаны
  // быть теми же самыми, иначе экран на мгновение заговорит расходящимся языком
  const source = await readFile(new URL('../assets/mockup-crm.js', import.meta.url), 'utf8');
  const line = source.split('\n').find((l) => l.includes('const fallback = {'));
  assert.ok(line, 'запасные слова моста пропали из mockup-crm.js');
  for (const [key, expected] of [['master', TERMS.barbershop.master.nom], ['client', TERMS.barbershop.client.nom], ['booking', TERMS.barbershop.booking.nom]]) {
    assert.ok(line.includes(`${key}: '${expected}'`), `мост разошёлся со словарём на слове ${key}`);
  }
});

test('до загрузки словарь уже рабочий - это барбершоп', () => {
  assert.equal(currentAppearance().vertical, 'barbershop');
  assert.equal(T('master.nomPl'), 'мастера');
  assert.equal(P('booking.new'), 'Новая запись');
});

// ── Загрузка ─────────────────────────────────────────────────────────────────

const clinicResponse = {
  vertical: 'clinic',
  terms: TERMS.clinic,
  phrases: PHRASES.clinic,
  modules: { missedProfit: false, payroll: true },
};
const okFetch = (body) => async () => ({ ok: true, json: async () => body });

test('после загрузки кабинет говорит словами своей вертикали', async () => {
  await loadAppearance('https://api.test', okFetch(clinicResponse));
  assert.equal(currentAppearance().vertical, 'clinic');
  assert.equal(T('master.nomPl'), 'врачи');
  assert.equal(T('client.datPl'), 'пациентам');
  assert.equal(P('booking.cancelled'), 'Приём отменён');
});

test('словарь берётся по своему адресу и без токена', async () => {
  const calls = [];
  await loadAppearance('https://api.test', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => clinicResponse };
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/tenant/appearance');
  assert.ok(!calls[0].opts?.headers?.Authorization, 'словарь нужен до входа, токена на нём быть не может');
});

test('сеть легла - кабинет остаётся на барбершопных словах, а не пустеет', async () => {
  const result = await loadAppearance('https://api.test', async () => {
    throw new Error('сеть недоступна');
  });
  assert.equal(result.vertical, 'barbershop');
  assert.equal(T('master.nom'), 'мастер');
});

test('сервер ответил отказом - тот же откат', async () => {
  await loadAppearance('https://api.test', async () => ({ ok: false, status: 404, json: async () => ({ error: 'unknown_tenant' }) }));
  assert.equal(currentAppearance().vertical, 'barbershop');
  assert.equal(T('booking.nom'), 'запись');
});

test('ответ пришёл мусором - кабинет не падает и не показывает пустоту', async () => {
  for (const junk of [null, 'строка', 42, [], {}, { terms: null }, { terms: {}, phrases: null }]) {
    resetAppearance();
    await assert.doesNotReject(() => loadAppearance('https://api.test', okFetch(junk)));
    assert.equal(T('master.nom'), 'мастер', `мусор ${JSON.stringify(junk)} прошёл как словарь`);
  }
});

test('в ответе не хватает одного термина - берётся барбершопный, экран цел', async () => {
  const partial = { vertical: 'clinic', terms: { master: TERMS.clinic.master }, phrases: {}, modules: {} };
  await loadAppearance('https://api.test', okFetch(partial));
  assert.equal(T('master.nom'), 'врач', 'то, что пришло, обязано примениться');
  assert.equal(T('client.nom'), 'клиент', 'чего не пришло - барбершопное, а не пустое');
  assert.equal(P('booking.new'), 'Новая запись');
});

test('в ответе не хватает одной формы - берётся барбершопная', async () => {
  const holed = structuredClone(clinicResponse);
  delete holed.terms.master.datPl;
  await loadAppearance('https://api.test', okFetch(holed));
  assert.equal(T('master.nom'), 'врач');
  assert.equal(T('master.datPl'), 'мастерам');
});

// ── Слова в тексте ───────────────────────────────────────────────────────────

test('неизвестный ключ виден глазами, а не превращается в пустоту', () => {
  assert.equal(T('dragon.nom'), 'dragon.nom');
  assert.equal(P('nosuch.phrase'), 'nosuch.phrase');
  assert.equal(T(''), '');
  assert.equal(T(null), '');
});

test('Tc отдаёт слово с большой буквы', async () => {
  assert.equal(Tc('master.nomPl'), 'Мастера');
  await loadAppearance('https://api.test', okFetch(clinicResponse));
  assert.equal(Tc('master.nomPl'), 'Врачи');
  assert.equal(Tc('client.nom'), 'Пациент');
});

test('счётная форма считает по-русски в обеих вертикалях', async () => {
  assert.equal(C('booking', 1), 'запись');
  assert.equal(C('booking', 3), 'записи');
  assert.equal(C('booking', 11), 'записей');
  await loadAppearance('https://api.test', okFetch(clinicResponse));
  assert.equal(C('booking', 1), 'приём');
  assert.equal(C('booking', 3), 'приёма');
  assert.equal(C('booking', 11), 'приёмов');
});

// ── Флаги разделов ───────────────────────────────────────────────────────────

test('до загрузки включено всё - у Алихана ничего не мигает и не пропадает', () => {
  assert.equal(moduleEnabled('missedProfit'), true);
  assert.equal(moduleEnabled('payroll'), true);
});

test('после загрузки действуют флаги арендатора', async () => {
  await loadAppearance('https://api.test', okFetch(clinicResponse));
  assert.equal(moduleEnabled('missedProfit'), false);
  assert.equal(moduleEnabled('payroll'), true);
});

test('неизвестный флаг считается выключенным, а не включённым', () => {
  assert.equal(moduleEnabled('dragons'), false);
});

// ── Подстановка в разметку ───────────────────────────────────────────────────
// Настоящего DOM в офлайн-наборе нет и заводить его нечем (у фронта нет npm).
// Подделка минимальная: applyTerms обязан обходиться querySelectorAll и полями узла

function fakeNode(attrs, text = '') {
  const node = {
    textContent: text,
    attributes: attrs,
    setAttribute(name, value) { node.attributes[name] = value; },
    getAttribute(name) { return name in node.attributes ? node.attributes[name] : null; },
    hasAttribute(name) { return name in node.attributes; },
  };
  return node;
}
function fakeRoot(nodes) {
  return {
    querySelectorAll(selector) {
      const attr = selector.replace(/[[\]]/g, '');
      return nodes.filter((n) => n.hasAttribute(attr));
    },
  };
}

test('data-term подставляет форму в текст узла', () => {
  const node = fakeNode({ 'data-term': 'master.nomPl' }, 'мастера');
  applyTerms(fakeRoot([node]));
  assert.equal(node.textContent, 'мастера');
});

test('data-term-cap ставит слово с большой буквы', async () => {
  await loadAppearance('https://api.test', okFetch(clinicResponse));
  const node = fakeNode({ 'data-term': 'master.nomPl', 'data-term-cap': '' }, 'Мастера');
  applyTerms(fakeRoot([node]));
  assert.equal(node.textContent, 'Врачи');
});

test('data-phrase подставляет фразу целиком', async () => {
  await loadAppearance('https://api.test', okFetch(clinicResponse));
  const node = fakeNode({ 'data-phrase': 'booking.new' }, 'Новая запись');
  applyTerms(fakeRoot([node]));
  assert.equal(node.textContent, 'Новый приём');
});

test('data-term-attr подставляет в атрибут, а не в текст', async () => {
  await loadAppearance('https://api.test', okFetch(clinicResponse));
  const node = fakeNode({ 'data-term-attr': 'placeholder:client.nom', placeholder: 'клиент' }, 'не трогать');
  applyTerms(fakeRoot([node]));
  assert.equal(node.getAttribute('placeholder'), 'пациент');
  assert.equal(node.textContent, 'не трогать', 'текст узла с data-term-attr трогать нельзя');
});

test('подстановка не роняет экран на битой разметке', () => {
  const nodes = [
    fakeNode({ 'data-term': '' }, 'пусто'),
    fakeNode({ 'data-term': 'dragon.nom' }, 'дракон'),
    fakeNode({ 'data-term-attr': 'безДвоеточия' }, 'кривой атрибут'),
    fakeNode({ 'data-phrase': 'нет.такой' }, 'нет фразы'),
  ];
  assert.doesNotThrow(() => applyTerms(fakeRoot(nodes)));
});

test('applyTerms без аргумента и без document не падает', () => {
  assert.doesNotThrow(() => applyTerms(null));
});
