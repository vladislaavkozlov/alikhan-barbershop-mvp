// Увольнение сотрудника (22.08.2026). Ключевое решение окна: увольнение - это АРХИВ,
// а не удаление строки из staff. На сотрудника ссылаются брони, зарплатные настройки
// и аналитика, поэтому DELETE физически невозможен без потери денег за отработанные
// периоды (и уже ронял прод 04.08.2026 - см. CLAUDE.md). Тесты закрепляют, что после
// увольнения история остаётся видимой, а сам человек исчезает из рабочих списков.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { firedLabel, formatEmploymentEnd, isEmployed, payrollStaff } from '../assets/crm-shared.js';

const root = new URL('../', import.meta.url);

const ACTIVE = { id: 'm-1', name: 'Мамедхан', employed: true, providesServices: true };
const FIRED = { id: 'm-2', name: 'Ушедший', employed: false, providesServices: true, employmentEndedAt: '2026-06-15' };
const FIRED_QUIET = { id: 'm-3', name: 'Давний', employed: false, providesServices: false };

test('уволенный с невыключенной галкой услуг больше не считается действующим', () => {
  // Ровно случай, который чинили в календаре 20.08.2026: employed=false, а
  // providesServices так и остался true. В "Финансах" он до этого окна проходил
  assert.equal(isEmployed(FIRED), false);
  assert.equal(isEmployed(ACTIVE), true);
  assert.equal(isEmployed({ id: 'x' }), true); // поля нет - человек в команде
});

test('payrollStaff: уволенный попадает в зарплаты, только если в периоде были оплаченные визиты', () => {
  const list = [ACTIVE, FIRED, FIRED_QUIET];
  // деньги в периоде были только у FIRED
  assert.deepEqual(payrollStaff(list, new Set(['m-1', 'm-2'])).map((s) => s.id), ['m-1', 'm-2']);
  // визитов ни у кого из уволенных - блок состоит из действующего состава
  assert.deepEqual(payrollStaff(list, new Set(['m-1'])).map((s) => s.id), ['m-1']);
});

test('payrollStaff без данных о визитах показывает только действующий состав', () => {
  // Брони не загрузились - уволенных не выдумываем, иначе в отчёте появятся строки
  // без единой подтверждённой суммы
  assert.deepEqual(payrollStaff([ACTIVE, FIRED], undefined).map((s) => s.id), ['m-1']);
});

test('работающий виден в зарплатах всегда, даже с нулём визитов', () => {
  // Пустая строка - это тоже ответ владельцу: "за неделю ноль"
  assert.deepEqual(payrollStaff([ACTIVE], new Set()).map((s) => s.id), ['m-1']);
});

test('дата увольнения показывается человеческим видом, а несуществующая не выдумывается', () => {
  assert.equal(formatEmploymentEnd('2026-06-15'), '15.06.2026');
  assert.equal(formatEmploymentEnd(null), '');
  assert.equal(firedLabel(FIRED), 'Не работает с 15.06.2026');
  // Уволен до появления колонки (миграция 055) - дату честно не знает никто
  assert.equal(firedLabel(FIRED_QUIET), 'Не работает');
});

test('сотрудник не удаляется из базы ни одним роутом - увольнение это флаг', async () => {
  const staffRoute = await readFile(new URL('api/routes/staff.js', root), 'utf8');
  // DELETE в этом файле есть только про медиа и сессии, но не про саму строку staff
  assert.equal(/DELETE FROM staff\b/.test(staffRoute), false, 'строку сотрудника удалять нельзя - на неё ссылаются брони и деньги');
  const migration = await readFile(new URL('api/migrations/055_staff_employment_ended.sql', root), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS employment_ended_at date/);
});

test('увольнение уходит своим роутом, а сохранение карточки трудоустройство не трогает', async () => {
  const [team, server, staffRoute] = await Promise.all([
    readFile(new URL('assets/crm-team.js', root), 'utf8'),
    readFile(new URL('api/server.mjs', root), 'utf8'),
    readFile(new URL('api/routes/staff.js', root), 'utf8'),
  ]);
  assert.match(team, /\/employment`, 'PUT', \{ employed:/);
  assert.match(server, /path: 'staff\/:id\/employment', auth: 'management'/);
  // В общем PUT /staff/:id поле теперь необязательное: без него колонка сохраняется
  // как есть, иначе правка имени возвращала бы уволенного в команду
  assert.match(staffRoute, /employed=COALESCE\(\$5,employed\)/);
  assert.match(staffRoute, /typeof body\.employed === 'boolean' \? body\.employed : null/);
});

test('увольнение подтверждается и объясняет последствия, а вход закрывается сразу', async () => {
  const [team, staffRoute] = await Promise.all([
    readFile(new URL('assets/crm-team.js', root), 'utf8'),
    readFile(new URL('api/routes/staff.js', root), 'utf8'),
  ]);
  // Двухшаговое подтверждение прямо в секции - конвенция проекта, не window.confirm
  assert.equal(/window\.confirm\(/.test(team), false); // упоминание в комментарии допустимо, вызов - нет
  assert.match(team, /data-fire-yes/);
  assert.match(team, /Записи, выручка и статистика за отработанные периоды останутся на месте/);
  // Сессии уволенного обрываются, иначе открытая вкладка живёт до истечения токена
  assert.match(staffRoute, /if \(!row\.employed\) await pool\.query\('DELETE FROM sessions WHERE staff_id = \$1'/);
});

test('раздел «Сотрудники» отделяет уволенных от действующего состава', async () => {
  const team = await readFile(new URL('assets/crm-team.js', root), 'utf8');
  assert.match(team, /const active = rows\.filter\(\(staff\) => staff\.employed !== false\)/);
  assert.match(team, /const fired = rows\.filter\(\(staff\) => staff\.employed === false\)/);
  assert.match(team, /team-fired-group/);
});

test('сервер отдаёт дату увольнения и команде, и аналитике', async () => {
  const [staffRoute, analytics] = await Promise.all([
    readFile(new URL('api/routes/staff.js', root), 'utf8'),
    readFile(new URL('api/routes/analytics.js', root), 'utf8'),
  ]);
  assert.match(staffRoute, /employmentEndedAt: dateColToStr\(r\.employment_ended_at\)/);
  assert.match(analytics, /employmentEndedAt: dateColToStr\(s\.employment_ended_at\)/);
  // Аналитика по-прежнему показывает уволенных с историей - их цифры не исчезают
  assert.match(analytics, /\(s\.provides_services && s\.employed\) \|\| byMaster\.has\(s\.id\)/);
});
