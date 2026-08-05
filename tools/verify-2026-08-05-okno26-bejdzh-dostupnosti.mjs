// Проверка Окна 26 - бейдж "ближайшая доступная дата" на карточке мастера в
// booking-форме, ДО выбора мастера/услуги/даты.
//
// Задача E промпта Окна 29 (05.08.2026) - переписано на автономность (было
// tools/verify-2026-08-04-okno26-bejdzh-dostupnosti.mjs, аудит 05.08 нашёл 2 дыры):
//   1. Ассерт сравнивал бейдж с ЛИТЕРАЛОМ даты '04.08.2026' - назавтра API честно
//      отдаёт другую дату, и тест краснеет сам по себе, хотя механизм верен. Теперь
//      проверяется ИНВАРИАНТ (формат "ближайшая запись - DD.MM.YYYY", не конкретное
//      число) - см. reference_barbershop-crm-tech.md, разбор аудита.
//   2. Требовал ВНЕШНЕ поднятого сервера + вручную наложенной фикстуры "master-2
//      недоступен 60 дней", а заявленный в комментарии teardown (DELETE) в теле
//      файла физически отсутствовал. Теперь весь стенд (Postgres + server.mjs) и
//      фикстура - свои, через tools/verify-lib.mjs, поднимаются и убираются самим
//      прогоном.
// Отдельно (не из исходного окна, найдено при переписывании под автономность):
// "недоступен 60 дней" и "нет стандартного графика вовсе" - РАЗНЫЕ вещи после
// Задачи C промпта Окна 29 (master_not_bookable/hasWorkingSchedule) - мастер без
// единого is_working=true теперь вообще не появляется в списке выбора, поэтому
// фикстура "недоступности" master-2 здесь - НЕ отсутствие графика, а нормальный
// рабочий график + разовые правки "выходной", блокирующие каждый день в окне
// MASTER_NEXT_AVAILABILITY_WINDOW_DAYS вперёд.
import { withBrowser } from './cdp.mjs';
import { withEphemeralServer, withStaticServer, makeChecker, daysFromToday } from './verify-lib.mjs';
import { MASTER_NEXT_AVAILABILITY_WINDOW_DAYS } from '../api/server.mjs';

const { check, summary } = makeChecker();

async function readMasterCards(s) {
  return s.eval(`Array.from(document.querySelectorAll('#master-grid .master-option')).map((wrap) => ({
    name: wrap.querySelector('.opt-name')?.textContent,
    badge: wrap.querySelector('.opt-availability')?.textContent ?? null,
    badgeNone: wrap.querySelector('.opt-availability--none') !== null,
    hasCallLink: wrap.querySelector('.opt-admin-call') !== null,
    callHref: wrap.querySelector('.opt-admin-call')?.getAttribute('href') ?? null,
  }))`);
}

let crashed = false;
try {
await withEphemeralServer(async ({ apiUrl, db }) => {
  // master-1/master-3: обычный рабочий график каждый день - должны появиться в
  // списке с бейджем "ближайшая запись - <какая-то дата>".
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT m.id, d, true, '10:00', '20:00'
     FROM (VALUES ('master-1'), ('master-3')) AS m(id), generate_series(1,7) d`
  );
  // master-2: тоже обычный рабочий график (значит виден в списке выбора - Задача C
  // промпта Окна 29 его не скрывает), но КАЖДЫЙ день на MASTER_NEXT_AVAILABILITY_WINDOW_DAYS
  // вперёд закрыт разовой правкой "выходной весь день" - реальный кейс "мастер в
  // отпуске", а не "мастеру ещё не завели график".
  await db.query(
    `INSERT INTO master_weekly_schedule (master_id, weekday, is_working, work_start, work_end)
     SELECT 'master-2', d, true, '10:00', '20:00' FROM generate_series(1,7) d`
  );
  const closeDays = Array.from({ length: MASTER_NEXT_AVAILABILITY_WINDOW_DAYS + 3 }, (_, i) => daysFromToday(i));
  for (const date of closeDays) {
    const shift = await db.query(
      `INSERT INTO schedule_shifts (master_id, date, start_time, end_time) VALUES ('master-2', $1, '10:00', '20:00') RETURNING id`,
      [date]
    );
    await db.query(`INSERT INTO schedule_breaks (shift_id, start_time, end_time) VALUES ($1, '10:00', '20:00')`, [shift.rows[0].id]);
  }

  await withStaticServer(apiUrl, async (base) => {
    await withBrowser(async (s) => {
      await s.navigate(`${base}/index.html`);
      await s.setViewport(390, 900, true);

      // Бейдж появляется асинхронно (batch fetch /masters-next-availability приходит
      // после первой отрисовки) - ждём реального ответа сети, не фиксированный таймаут.
      let cards = [];
      for (let i = 0; i < 20; i++) {
        cards = await readMasterCards(s);
        if (cards.length >= 3 && cards.every((c) => c.badge || c.badgeNone)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      console.log('Карточки мастеров:', JSON.stringify(cards, null, 2));

      check('3 карточки мастеров отрисованы (у всех троих есть график - Задача C их не скрывает)', cards.length === 3);

      const master1 = cards.find((c) => c.name === 'Алиовсад'); // свободен
      const master2 = cards.find((c) => c.name === 'Мамедхан'); // закрыт на N дней вперёд
      const master3 = cards.find((c) => c.name === 'Елизавета'); // свободна

      const dateBadgeRe = /^ближайшая запись - \d{2}\.\d{2}\.\d{4}$/;
      check('Алиовсад (свободен): бейдж формата "ближайшая запись - ДД.ММ.ГГГГ" (не литерал даты)', !!master1?.badge && dateBadgeRe.test(master1.badge), master1?.badge);
      check('Алиовсад (свободен): нет ссылки на администратора', master1?.hasCallLink === false);

      check('Мамедхан (закрыт на N дней вперёд): бейдж "сейчас нет свободных мест"', master2?.badge === 'сейчас нет свободных мест');
      check('Мамедхан: класс opt-availability--none применён', master2?.badgeNone === true);
      check('Мамедхан: есть ссылка "Позвонить администратору"', master2?.hasCallLink === true);
      check('Мамедхан: ссылка ведёт на реальный номер салона', master2?.callHref === 'tel:+79899977070');

      check('Елизавета (свободна): бейдж формата "ближайшая запись - ДД.ММ.ГГГГ"', !!master3?.badge && dateBadgeRe.test(master3.badge), master3?.badge);

      // Клик по карточке с недоступным мастером всё ещё выбирает его (бейдж не блокирует
      // выбор - клиент может захотеть посмотреть его услуги/записаться позже вручную через
      // администратора) - регрессия поведения выбора, не только бейдж.
      const idx = cards.findIndex((c) => c.name === 'Мамедхан') + 1;
      await s.click(`#master-grid .master-option:nth-child(${idx}) .option-card`);
      await new Promise((r) => setTimeout(r, 150));
      const selectedAfterClick = await s.eval(
        `document.querySelector('#master-grid .master-option:nth-child(${idx}) .option-card').classList.contains('selected')`
      );
      check('Клик по недоступному мастеру всё равно выбирает его (не заблокирован)', selectedAfterClick === true);

      const serviceGridEnabled = await s.eval(`document.getElementById('service-grid').getAttribute('aria-disabled')`);
      check('После выбора недоступного мастера шаг "услуги" разблокирован как обычно', serviceGridEnabled === null);
    });
  });
});
} catch (err) {
  crashed = true;
  console.error('Прогон упал с ошибкой:', err);
}
process.exit(summary() && !crashed ? 0 : 1);
