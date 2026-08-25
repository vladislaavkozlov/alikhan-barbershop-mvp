// Этап B: сито №1 - барбершопные слова в исходниках (24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// Цель окна - чтобы слова жили в одном месте. Проверить это глазами нельзя: они
// размазаны по 28 файлам. Здесь считается, сколько строк видимого текста осталось, и
// сверяется с базой отсчёта ниже.
//
// База - храповик: число может только убывать. Стало больше - тест падает (кто-то
// написал новое барбершопное слово руками). Стало меньше - тест ТОЖЕ падает и требует
// опустить базу, иначе вычищенные файлы молча зарастут обратно.
//
// Правило счёта общее с tools/list-vertical-leftovers.mjs, который печатает список
// работ по файлу: два счётчика разошлись бы на первой же правке.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { leftoverLines } from '../tools/vertical-leftovers-core.mjs';

const ROOT = new URL('../', import.meta.url);

// Единственное исключение - сам словарь: это и есть то «одно место», где барбершопные
// слова обязаны лежать. Считать его нарушением значило бы требовать систему без слов
const DICTIONARY = 'assets/crm-terms.js';

async function countLeftovers(relative) {
  return leftoverLines(await readFile(new URL(relative, ROOT), 'utf8')).length;
}

// База отсчёта на 24.08.2026, конец фазы 4: общие модули (фаза 3) и кабинет владельца
// со своими модулями вычищены. 225 строк → 115 → 36. Остались кабинеты администратора
// и мастера, их разбирают фазы 5 и 6.
//
// 225, а не 424 из первого грубого замера: тот считал продолжения HTML-комментариев
// и строки импортов
const BASELINE = {
  'crm-master.html': 19,
  'crm-admin.html': 16,
};

test('барбершопных слов в исходниках не стало больше, чем в базе отсчёта', async () => {
  const worse = [];
  const better = [];
  for (const [file, allowed] of Object.entries(BASELINE)) {
    const actual = await countLeftovers(file);
    if (actual > allowed) worse.push(`${file}: было ${allowed}, стало ${actual}`);
    if (actual < allowed) better.push(`${file}: ${allowed} → ${actual}`);
  }
  assert.deepEqual(worse, [], 'барбершопное слово написано руками вместо словаря');
  assert.deepEqual(
    better,
    [],
    `файлы вычищены - опусти базу отсчёта в этом тесте, иначе они молча зарастут обратно:\n${better.join('\n')}`
  );
});

test('база отсчёта не забыла ни одного файла кабинетов', async () => {
  const missing = [];
  const assets = (await readdir(new URL('assets/', ROOT))).filter((f) => f.endsWith('.js'));
  const files = [...assets.map((f) => `assets/${f}`), 'crm-owner.html', 'crm-admin.html', 'crm-master.html'];
  for (const file of files) {
    if (file === DICTIONARY || file in BASELINE) continue;
    if ((await countLeftovers(file)) > 0) missing.push(file);
  }
  assert.deepEqual(missing, [], 'файл с барбершопными словами не попал в базу отсчёта');
});
