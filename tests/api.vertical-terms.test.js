// Этап B мультиарендности, Фаза 1 (24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
// Контракт словаря вертикали: слова живут в ОДНОМ месте, форма приходит по запросу,
// незнакомая вертикаль падает в барбершопные слова.
//
// Почему тесты про формы, а не про одно слово. В кабинетах живут 39 падежных форм
// (замер грепом 24.08.2026: «записи» 235 раз, «мастера» 168, «мастеру» 39), а род у
// пар не совпадает: запись женского рода, приём мужского; салон мужского, клиника
// женского. Подстановка одного слова дала бы «Новая приём» - хуже, чем не переводить.
// Отсюда два слоя: формы существительных и отдельный список фраз, где рядом стоит
// согласуемое слово.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_VERTICAL,
  FORMS,
  TERM_KEYS,
  TERMS,
  PHRASES,
  appearanceFor,
  term,
  phrase,
  countedTerm,
} from '../api/lib/vertical-terms.js';
import {
  MODULE_KEYS,
  MODULE_DEFAULTS,
  effectiveModules,
  normalizeTenantModules,
} from '../api/lib/vertical-modules.js';
import { matchRoute } from '../api/server.mjs';

const VERTICALS = Object.keys(TERMS);

test('барбершоп - вертикаль по умолчанию и она описана', () => {
  assert.equal(DEFAULT_VERTICAL, 'barbershop');
  assert.ok(TERMS[DEFAULT_VERTICAL], 'словарь барбершопа обязан существовать');
});

test('у каждой вертикали заполнены все термины и все формы', () => {
  for (const vertical of VERTICALS) {
    for (const key of TERM_KEYS) {
      const entry = TERMS[vertical][key];
      assert.ok(entry, `${vertical}: нет термина ${key}`);
      assert.ok(['m', 'f', 'n'].includes(entry.g), `${vertical}.${key}: не объявлен род`);
      for (const form of FORMS) {
        const value = entry[form];
        assert.ok(typeof value === 'string' && value.trim(), `${vertical}.${key}: пустая форма ${form}`);
      }
    }
  }
});

test('клиника говорит своими словами, а не копией барбершопа', () => {
  for (const key of TERM_KEYS) {
    assert.notEqual(
      TERMS.clinic[key].nom,
      TERMS.barbershop[key].nom,
      `клиника не должна повторять барбершопное слово ${key}`
    );
  }
});

test('формы одного термина различимы: единственное и множественное не совпадают', () => {
  for (const vertical of VERTICALS) {
    for (const key of TERM_KEYS) {
      const entry = TERMS[vertical][key];
      assert.notEqual(entry.nom, entry.nomPl, `${vertical}.${key}: единственное и множественное совпали`);
      assert.notEqual(entry.gen, entry.genPl, `${vertical}.${key}: родительный ед. и мн. совпали`);
    }
  }
});

test('незнакомая вертикаль падает в барбершопные слова, а не ломает экран', () => {
  const unknown = appearanceFor('petshop');
  assert.equal(unknown.vertical, 'barbershop');
  assert.equal(unknown.terms.master.nom, 'мастер');
  assert.deepEqual(unknown.terms, TERMS.barbershop);
  assert.deepEqual(unknown.phrases, PHRASES.barbershop);
});

test('пустая, отсутствующая и мусорная вертикаль тоже падают в барбершоп', () => {
  for (const value of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(appearanceFor(value).vertical, 'barbershop');
  }
});

test('term отдаёт запрошенную форму', () => {
  assert.equal(term('barbershop', 'master.nomPl'), 'мастера');
  assert.equal(term('clinic', 'master.nomPl'), 'врачи');
  assert.equal(term('barbershop', 'booking.gen'), 'записи');
  assert.equal(term('clinic', 'booking.gen'), 'приёма');
  assert.equal(term('clinic', 'client.datPl'), 'пациентам');
});

test('term без формы отдаёт именительный падеж', () => {
  assert.equal(term('clinic', 'service'), TERMS.clinic.service.nom);
});

test('неизвестный ключ и неизвестная форма отдают видимое значение, а не пустоту', () => {
  assert.equal(term('clinic', 'dragon.nom'), 'dragon.nom');
  assert.equal(term('clinic', 'master.ablative'), 'master.ablative');
  assert.doesNotThrow(() => term('clinic', ''));
});

test('счётная форма: 1 / 2 / 5 в обеих вертикалях', () => {
  assert.equal(countedTerm('barbershop', 'booking', 1), 'запись');
  assert.equal(countedTerm('barbershop', 'booking', 2), 'записи');
  assert.equal(countedTerm('barbershop', 'booking', 5), 'записей');
  assert.equal(countedTerm('clinic', 'booking', 1), 'приём');
  assert.equal(countedTerm('clinic', 'booking', 2), 'приёма');
  assert.equal(countedTerm('clinic', 'booking', 5), 'приёмов');
  // 11-14 и 21 - те места, где наивное правило врёт
  assert.equal(countedTerm('clinic', 'client', 11), 'пациентов');
  assert.equal(countedTerm('clinic', 'client', 21), 'пациент');
  assert.equal(countedTerm('barbershop', 'master', 0), 'мастеров');
});

test('набор фраз одинаков у всех вертикалей и нигде не совпадает дословно', () => {
  const base = Object.keys(PHRASES[DEFAULT_VERTICAL]).sort();
  assert.ok(base.length > 0, 'список фраз пуст - слой фраз не заведён');
  for (const vertical of VERTICALS) {
    assert.deepEqual(Object.keys(PHRASES[vertical]).sort(), base, `${vertical}: набор фраз разошёлся`);
  }
  for (const key of base) {
    assert.notEqual(PHRASES.clinic[key], PHRASES.barbershop[key], `фраза ${key} не переведена для клиники`);
  }
});

test('фразы про запись согласованы по роду: у клиники мужской род', () => {
  // Ровно та ошибка, ради которой заведён слой фраз: подстановка слова дала бы
  // «Новая приём» и «Приём отменена»
  assert.equal(phrase('barbershop', 'booking.new'), 'Новая запись');
  assert.equal(phrase('clinic', 'booking.new'), 'Новый приём');
  assert.equal(phrase('barbershop', 'booking.cancelled'), 'Запись отменена');
  assert.equal(phrase('clinic', 'booking.cancelled'), 'Приём отменён');
});

test('подстановка в фразу сохраняет согласование, а не режет её на куски', () => {
  assert.equal(
    phrase('barbershop', 'msg.cancelled', { when: 'завтра в 14:00' }),
    'Ваша запись завтра в 14:00 отменена'
  );
  assert.equal(
    phrase('clinic', 'msg.cancelled', { when: 'завтра в 14:00' }),
    'Ваш приём завтра в 14:00 отменён'
  );
});

test('нехватка подстановки оставляет метку видимой, а не пустое место', () => {
  assert.match(phrase('clinic', 'msg.cancelled', {}), /\{when\}/);
});

test('неизвестная фраза отдаёт барбершопную, а неизвестная везде - свой ключ', () => {
  assert.equal(phrase('petshop', 'booking.new'), 'Новая запись');
  assert.equal(phrase('clinic', 'booking.nosuch'), 'booking.nosuch');
});

test('appearanceFor не отдаёт наружу ничего, кроме слов и вертикали', () => {
  assert.deepEqual(Object.keys(appearanceFor('clinic')).sort(), ['phrases', 'terms', 'vertical']);
});

test('appearanceFor отдаёт копию, правка ответа не портит словарь', () => {
  const got = appearanceFor('clinic');
  got.terms.master.nom = 'сломано';
  assert.equal(TERMS.clinic.master.nom, 'врач');
});

// ── Флаги модулей ────────────────────────────────────────────────────────────

test('флаги модулей - ровно те два, что назвал Влад 24.08.2026', () => {
  assert.deepEqual([...MODULE_KEYS].sort(), ['missedProfit', 'payroll']);
});

test('у барбершопа оба модуля включены - у Алихана ничего не пропало', () => {
  const modules = effectiveModules('barbershop', {});
  assert.equal(modules.missedProfit, true);
  assert.equal(modules.payroll, true);
});

test('незнакомая вертикаль получает барбершопные умолчания', () => {
  assert.deepEqual(effectiveModules('petshop', {}), MODULE_DEFAULTS.barbershop);
  assert.deepEqual(effectiveModules(null, null), MODULE_DEFAULTS.barbershop);
});

test('значение арендатора перебивает умолчание вертикали', () => {
  const modules = effectiveModules('clinic', { missedProfit: false });
  assert.equal(modules.missedProfit, false);
  assert.equal(modules.payroll, MODULE_DEFAULTS.barbershop.payroll);
});

test('мусор в справочнике не включает и не выключает модуль молча', () => {
  assert.deepEqual(normalizeTenantModules({ payroll: 'да', dragons: true }), {});
  assert.deepEqual(normalizeTenantModules(null), {});
  assert.deepEqual(normalizeTenantModules('{}'), {});
  assert.deepEqual(normalizeTenantModules({ payroll: false }), { payroll: false });
});

test('в ответе флагов нет ключей, которых нет в списке модулей', () => {
  const modules = effectiveModules('clinic', { dragons: true });
  assert.deepEqual(Object.keys(modules).sort(), [...MODULE_KEYS].sort());
});

// ── Роут словаря ─────────────────────────────────────────────────────────────

test('GET /tenant/appearance зарегистрирован и открыт без входа', () => {
  const route = matchRoute('GET', ['tenant', 'appearance']);
  assert.ok(route, 'роут словаря не зарегистрирован - гейт реестра отдаст 404');
  assert.equal(route.auth, 'public', 'словарь нужен экрану входа, до входа в систему');
});

test('словарь отдаётся только на чтение', () => {
  assert.equal(matchRoute('POST', ['tenant', 'appearance']), null);
  assert.equal(matchRoute('PUT', ['tenant', 'appearance']), null);
});

test('словарь не удерживает соединение из пула - он не ходит в базу', async () => {
  // Узкий пул - причина, по которой 24.08.2026 выключили поток живых событий.
  // Словарь дёргается при каждом открытии кабинета, то есть чаще всего остального
  const source = await readFile(new URL('../api/server.mjs', import.meta.url), 'utf8');
  assert.match(source, /DETACHED_ROUTES = new Set\(\[[^\]]*'tenant'[^\]]*\]\)/);
});

// ── Миграция 060 ─────────────────────────────────────────────────────────────

const migration = await readFile(new URL('../api/migrations/060_tenant_modules.sql', import.meta.url), 'utf8');

test('миграция добавляет флаги модулей в справочник арендаторов', () => {
  assert.match(migration, /ALTER TABLE tenants\s+ADD COLUMN IF NOT EXISTS modules jsonb NOT NULL DEFAULT '\{\}'/i);
});

test('миграция только про схему: никаких правок данных', () => {
  const body = migration.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(body, /\bUPDATE\b/i, 'миграции не правят данные (правило Этапа A)');
  assert.doesNotMatch(body, /\bDELETE\b/i);
  assert.doesNotMatch(body, /INSERT INTO (?!tenants)/i, 'единственное исключение - строки справочника tenants');
});

// ── Флаги режут раздел на сервере, а не только в меню ────────────────────────
// Скрытый пункт меню защищает от промаха мышью, но не от прямого запроса к API -
// ровно та же логика, что у реестра прав (Окно 33)

test('роуты выключаемых разделов помечены модулем в реестре', () => {
  const byModule = { payroll: [], missedProfit: [] };
  for (const [method, path] of [
    ['GET', ['payroll-settings']], ['PUT', ['payroll-settings']], ['GET', ['payroll']],
    ['GET', ['finance', 'missed-profit']], ['GET', ['finance', 'missed-profit', 'clients']],
    ['GET', ['analytics', 'renew-discussed']], ['GET', ['analytics', 'lapsed']],
  ]) {
    const route = matchRoute(method, path);
    assert.ok(route, `${method} /${path.join('/')} нет в реестре`);
    assert.ok(route.module, `${method} /${path.join('/')} не помечен модулем`);
    byModule[route.module].push(path.join('/'));
  }
  assert.deepEqual(byModule.payroll.sort(), ['payroll', 'payroll-settings', 'payroll-settings']);
  assert.deepEqual(
    byModule.missedProfit.sort(),
    ['analytics/lapsed', 'analytics/renew-discussed', 'finance/missed-profit', 'finance/missed-profit/clients']
  );
});

test('ввод срока возврата НЕ выключается флагом - иначе визит не закрыть', () => {
  // Решение 24.08.2026: флаг режет ОТЧЁТЫ, а не ввод данных. Без срока и причины
  // визит закрыть нельзя (renew-required-note в кабинете), поэтому PATCH остаётся
  const route = matchRoute('PATCH', ['clients', 'x', 'renew']);
  assert.ok(route);
  assert.equal(route.module, undefined);
});

test('модуль объявлен только известными флагами', () => {
  for (const path of [['payroll'], ['finance', 'missed-profit'], ['analytics', 'lapsed']]) {
    const route = matchRoute('GET', path);
    assert.ok(MODULE_KEYS.includes(route.module), `${route.module} нет в списке флагов`);
  }
});
