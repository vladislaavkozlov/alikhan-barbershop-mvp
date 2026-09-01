// Блок «Напоминания в Telegram» в карточке клиента (Волна 1, 01.09.2026).
//
// Что здесь проверяется. Не вёрстка ради вёрстки, а три решения, которые легко
// растерять при следующей правке:
//   1. у заведения без подключённого бота кнопки нет ВОВСЕ - недоступное действие
//      не показывается с объяснением, оно просто отсутствует;
//   2. человеку, который уже в боте, показано состояние, а не предложение;
//   3. отписавшемуся кнопка возвращается - новая ссылка вернёт напоминания.
//
// Плюс сито вертикали: подписи берутся из словаря, поэтому в клинике блок говорит
// «пациенту», а не «клиенту».
import assert from 'node:assert/strict';
import test from 'node:test';
import { botSectionMarkup } from '../assets/crm-client-bot.js';
import { loadAppearance, resetAppearance } from '../assets/crm-terms.js';

const card = (bot) => ({ id: 'cl-1', name: 'Мария', bot });

test('бота у заведения нет - блока нет вовсе, без объяснений на экране', () => {
  assert.equal(botSectionMarkup(card({ available: false })), '');
  assert.equal(botSectionMarkup({ id: 'cl-1' }), '');
});

test('бот есть, человек не привязан - предлагаем пригласить', () => {
  const html = botSectionMarkup(card({ available: true, linkedAt: null, unsubscribedAt: null }));
  assert.match(html, /data-bot-invite="cl-1"/);
  assert.match(html, /Пригласить в бота/);
  // Поле со ссылкой скрыто до нажатия: ссылка одноразовая, показывать заранее нечего
  assert.match(html, /data-bot-link hidden/);
});

test('человек уже в боте - показано состояние, а не предложение', () => {
  const html = botSectionMarkup(card({ available: true, linkedAt: '2026-09-01T10:00:00.000Z' }));
  assert.doesNotMatch(html, /data-bot-invite/, 'привязанному предлагают привязаться ещё раз');
  assert.match(html, /подключены/);
});

test('отписавшемуся кнопка возвращается вместе с честной пометкой', () => {
  const html = botSectionMarkup(card({
    available: true,
    linkedAt: '2026-09-01T10:00:00.000Z',
    unsubscribedAt: '2026-09-01T12:00:00.000Z',
  }));
  assert.match(html, /data-bot-invite/);
  assert.match(html, /отписался/);
});

test('в клинике блок говорит языком клиники', async () => {
  resetAppearance();
  await loadAppearance('', async () => ({
    ok: true,
    json: async () => ({ vertical: 'clinic', terms: { client: { nom: 'пациент', dat: 'пациенту' } } }),
  }));
  const html = botSectionMarkup(card({ available: true, unsubscribedAt: '2026-09-01T12:00:00.000Z' }));
  assert.match(html, /пациент отписался/i, `в клинике написано: ${html}`);
  assert.match(html, /отправьте её пациенту/i);
  resetAppearance();
});
