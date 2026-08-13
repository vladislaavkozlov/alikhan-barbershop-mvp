// Комментарий сотрудника к записи (13.08.2026, Влад: "Фактическая сумма" подтягивает
// сумму услуг, администратор может её скорректировать - и должен объяснить почему,
// чтобы через месяц отличие от прайса не выглядело ошибкой ввода). Миграция 048
// (bookings.staff_comment) + расширение PATCH /bookings/:id/actual-price.
//
// ЧТО ПОКРЫТО ЗДЕСЬ: нормализация комментария (normalizeStaffComment) - единственное
// место, где решается, что попадёт в базу: пустая строка = "комментария нет", а не
// пустая строка-призрак в истории визитов; чужой тип и перебор длины отбиваются 400,
// а не пишутся молча. Плюс срезка поля по роли в shapeClientCardForViewer: мастер не
// видит фактическую сумму, значит и объяснение к ней ему не показываем.
//
// ЧТО ПОКРЫТО ЖИВЫМ ПРОГОНОМ, а не здесь: сам UPDATE и обратное чтение через
// GET /bookings и карточку клиента - handleBookingActualPrice работает на общем pool,
// под fake client его не подставить без рефакторинга стабильного кода (та же причина,
// что в tests/api.booking-reschedule.test.js). Живьём -
// tools/verify-2026-08-13-okno59-kartochka-zapisi.mjs на эфемерной базе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStaffComment, BOOKING_COMMENT_MAX_LEN } from '../api/server.mjs';
import { shapeClientCardForViewer } from '../api/routes/clients.js';

test('комментарий: обычный текст сохраняется как есть, без лишних пробелов по краям', () => {
  assert.deepEqual(normalizeStaffComment('  Владелец дал скидку  '), { value: 'Владелец дал скидку' });
});

test('комментарий: пустое поле и пробелы = комментария нет (null), а не пустая строка', () => {
  assert.deepEqual(normalizeStaffComment(''), { value: null });
  assert.deepEqual(normalizeStaffComment('   '), { value: null });
  assert.deepEqual(normalizeStaffComment(null), { value: null });
});

test('комментарий: не строка - ошибка, а не молчаливое приведение к тексту', () => {
  assert.deepEqual(normalizeStaffComment(42), { error: 'invalid_comment' });
  assert.deepEqual(normalizeStaffComment({ text: 'скидка' }), { error: 'invalid_comment' });
});

test('комментарий: длиннее лимита - ошибка, ровно по лимиту - проходит', () => {
  const maxOk = 'я'.repeat(BOOKING_COMMENT_MAX_LEN);
  assert.deepEqual(normalizeStaffComment(maxOk), { value: maxOk });
  assert.deepEqual(normalizeStaffComment('я'.repeat(BOOKING_COMMENT_MAX_LEN + 1)), { error: 'comment_too_long' });
});

// Роли: карточка клиента отдаёт историю визитов, и комментарий про скидку - разговор
// владельца с администратором, не рабочая информация мастера (тот же уровень, что у
// actualPrice в /bookings).
const CARD = {
  id: 'client-1',
  name: 'Сергей',
  phone: '+79001112233',
  visits: [
    { id: 'b-1', masterId: 'master-1', locationId: 'loc-1', services: [], staffComment: 'скидка от владельца' },
    { id: 'b-2', masterId: 'master-2', locationId: 'loc-1', services: [], staffComment: null },
  ],
};

test('карточка клиента: владелец видит комментарий к визиту', () => {
  const shaped = shapeClientCardForViewer(CARD, { role: 'owner' });
  assert.equal(shaped.visits[0].staffComment, 'скидка от владельца');
});

test('карточка клиента: администратор своей точки видит комментарий', () => {
  const shaped = shapeClientCardForViewer(CARD, { role: 'admin', locationId: 'loc-1' });
  assert.equal(shaped.visits.length, 2);
  assert.equal(shaped.visits[0].staffComment, 'скидка от владельца');
});

test('карточка клиента: мастер не получает поле комментария вовсе (не null, а отсутствует)', () => {
  const shaped = shapeClientCardForViewer(CARD, { role: 'master', id: 'master-1' });
  assert.equal(shaped.visits.length, 1);
  assert.equal('staffComment' in shaped.visits[0], false);
  // Сам визит при этом остаётся полноценным - срезано поле, не запись
  assert.equal(shaped.visits[0].id, 'b-1');
});
