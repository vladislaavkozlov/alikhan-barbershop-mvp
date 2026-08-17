// 17.08.2026, задача Влада: «в Команде дать поставить мастеру график с любого
// времени по любое (00:00-23:59), и чтобы время записи работало по нему и в CRM, и
// на сайте». Шкала календаря «День» до этого была жёстко 10:00-20:00 (константы
// DAY_START_MIN/DAY_END_MIN в assets/crm-calendar.js + статичные <span> подписи в
// crm-owner.html/crm-admin.html/crm-master.html + height:640px/748px в
// assets/mockup-crm.css) - у мастера, работающего ночью, карточка записи получала
// отрицательный top и физически не была видна, а клик по треку зажимался в 10-20.
//
// Здесь ровно расчёт: какое окно суток должен показать день и где стоят подписи
// часов. Без DOM и без сети - поэтому проверяется офлайн-тестами
// (tests/crm-day-window.test.js), а не только живым CDP-прогоном.

// Дефолт = прежняя шкала. Обычный день салона (10:00-20:00) обязан выглядеть
// точно так же, как до этой правки - расширяется окно только когда для этого есть
// реальная причина (смена или запись за его пределами).
export const DEFAULT_DAY_START_MIN = 600; // 10:00
export const DEFAULT_DAY_END_MIN = 1200; // 20:00
export const PX_PER_MIN = 64 / 60; // 64px = 1 час, та же шкала, что и в CSS

// Возвращает минуты или null. null - для битого/пустого значения: график приходит
// из сети, и одна плохая строка не должна ронять весь день (см. тест «битые значения
// игнорируются»).
export function toDayMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// «Выходной» в этой схеме - не флаг, а перерыв, накрывающий смену целиком (та же
// семантика, что у isScheduleDayOff/fullDayOffWindow на сервере,
// api/lib/schedule-core.js). Границы берём у САМОЙ смены, не у шкалы: мастер с
// круглосуточным окном получает перерыв 00:00-23:59, а мастер со сменой 12:00-18:00 -
// объединение своего окна с дефолтом, и оба обязаны читаться как выходной.
export function isDayOffShift(shift) {
  const start = toDayMinutes(shift?.startTime);
  const end = toDayMinutes(shift?.endTime);
  if (start == null || end == null) return false;
  return (shift?.breaks ?? []).some((b) => {
    const bs = toDayMinutes(b?.startTime);
    const be = toDayMinutes(b?.endTime);
    return bs != null && be != null && bs <= start && be >= end;
  });
}

// Окно шкалы дня = дефолт 10:00-20:00, раздвинутый до РАБОЧИХ ЧАСОВ мастеров этого
// дня, с округлением до целого часа (шкала подписана часами, ползать на 15 минут ей
// незачем). Выходной день мастера окно НЕ раздвигает: его трек рисуется заглушкой
// «Выходной», а раздвинутая из-за него шкала растянула бы день остальных мастеров
// на пустое место.
//
// Правка по решению Влада 17.08.2026: шкалу раздвигает ТОЛЬКО график («эти часы нужно
// ставить только если у сотрудника есть рабочие часы в это время»). Брони на неё не
// влияют - персонал может записать клиента и вне смены, и такие записи не должны
// растягивать день всем остальным. Чтобы они при этом не пропадали, карточка вне
// шкалы прижимается к её краю и помечается (см. positionStyle/appt--outside в
// assets/crm-calendar.js), а не исчезает.
export function computeDayWindow({ shifts = [] } = {}) {
  let startMin = DEFAULT_DAY_START_MIN;
  let endMin = DEFAULT_DAY_END_MIN;

  const stretch = (from, to) => {
    if (from == null || to == null || to <= from) return;
    startMin = Math.min(startMin, from);
    endMin = Math.max(endMin, to);
  };

  for (const shift of shifts) {
    if (!shift || isDayOffShift(shift)) continue;
    stretch(toDayMinutes(shift.startTime), toDayMinutes(shift.endTime));
  }

  return {
    startMin: Math.floor(startMin / 60) * 60,
    endMin: Math.ceil(endMin / 60) * 60, // 23:59 → 24:00, иначе последний час обрезан
  };
}

// Подписи часовой шкалы слева. 24:00 в конце суток - не время дня, а граница шкалы
// (та же роль, что у 20:00 в прежней статичной разметке).
export function hourMarksFor({ startMin, endMin }) {
  const marks = [];
  for (let m = startMin; m <= endMin; m += 60) {
    const h = Math.floor(m / 60);
    marks.push({ label: `${String(h).padStart(2, '0')}:00`, top: Math.round((m - startMin) * PX_PER_MIN) });
  }
  return marks;
}

export function dayWindowHeightPx({ startMin, endMin }) {
  return Math.round((endMin - startMin) * PX_PER_MIN);
}
