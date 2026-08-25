// Словарь терминов вертикали (Этап B мультиарендности, Фаза 1, 24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// ЕДИНСТВЕННЫЙ источник слов на всю систему. Кабинеты забирают его роутом
// GET /tenant/appearance и своей копии словаря не держат: фронт живёт на чужом
// домене отдельным контуром, а на Amvera уезжают только server.mjs, lib/, routes/
// и migrations/ - файл вне этих папок на бэкенд просто не попадёт.
//
// Почему формы, а не одно слово. Замер грепом 24.08.2026 по боевым кабинетам: в
// текстах живут 39 падежных форм («записи» 235 раз, «мастера» 168, «мастеру» 39).
// Подстановка одного слова оставила бы «Перенесена мастер».
//
// Почему рядом отдельный слой фраз. Род у пар не совпадает: запись женского рода,
// приём мужского; салон мужского, клиника женского. Всё согласуемое рядом ломается -
// «Новая запись» стало бы «Новая приём». Такие места выводить правилом нельзя, они
// пишутся руками и лежат в PHRASES.
//
// Почему словарь в коде, а не в базе. Слова правит разработчик и откатывает вместе
// с кодом; их проверяет офлайн-набор. В справочнике арендаторов живут только флаги
// модулей (vertical-modules.js) - там значение и правда своё на каждого клиента.
//
// ⚠️ СЛОВА КЛИНИКИ НЕ СОГЛАСОВАНЫ С КАРИНОЙ. Это черновик окна 68, подтверждённый
// Владом 24.08.2026 как рабочий до её ответа. Правка после ответа - один диф в этом
// файле, ходить по кабинетам не придётся.

export const DEFAULT_VERTICAL = 'barbershop';

// Шесть падежей в двух числах. Список закрыт: форма, которой здесь нет, не может
// понадобиться в русском тексте кабинета
export const FORMS = [
  'nom', 'gen', 'dat', 'acc', 'ins', 'pre',
  'nomPl', 'genPl', 'datPl', 'accPl', 'insPl', 'prePl',
];

// Сущности из брифа окна 68. Шестого слова («стрижка») здесь осознанно нет: у
// клиники ему нет однословного соответствия, эти места переводятся фразой на
// фазах кабинетов
export const TERM_KEYS = ['master', 'booking', 'service', 'client', 'place'];

export const TERMS = {
  barbershop: {
    master: {
      g: 'm',
      nom: 'мастер', gen: 'мастера', dat: 'мастеру', acc: 'мастера', ins: 'мастером', pre: 'мастере',
      nomPl: 'мастера', genPl: 'мастеров', datPl: 'мастерам', accPl: 'мастеров', insPl: 'мастерами', prePl: 'мастерах',
    },
    booking: {
      g: 'f',
      nom: 'запись', gen: 'записи', dat: 'записи', acc: 'запись', ins: 'записью', pre: 'записи',
      nomPl: 'записи', genPl: 'записей', datPl: 'записям', accPl: 'записи', insPl: 'записями', prePl: 'записях',
    },
    service: {
      g: 'f',
      nom: 'услуга', gen: 'услуги', dat: 'услуге', acc: 'услугу', ins: 'услугой', pre: 'услуге',
      nomPl: 'услуги', genPl: 'услуг', datPl: 'услугам', accPl: 'услуги', insPl: 'услугами', prePl: 'услугах',
    },
    client: {
      g: 'm',
      nom: 'клиент', gen: 'клиента', dat: 'клиенту', acc: 'клиента', ins: 'клиентом', pre: 'клиенте',
      nomPl: 'клиенты', genPl: 'клиентов', datPl: 'клиентам', accPl: 'клиентов', insPl: 'клиентами', prePl: 'клиентах',
    },
    place: {
      g: 'm',
      nom: 'салон', gen: 'салона', dat: 'салону', acc: 'салон', ins: 'салоном', pre: 'салоне',
      nomPl: 'салоны', genPl: 'салонов', datPl: 'салонам', accPl: 'салоны', insPl: 'салонами', prePl: 'салонах',
    },
  },
  clinic: {
    master: {
      g: 'm',
      nom: 'врач', gen: 'врача', dat: 'врачу', acc: 'врача', ins: 'врачом', pre: 'враче',
      nomPl: 'врачи', genPl: 'врачей', datPl: 'врачам', accPl: 'врачей', insPl: 'врачами', prePl: 'врачах',
    },
    booking: {
      g: 'm',
      nom: 'приём', gen: 'приёма', dat: 'приёму', acc: 'приём', ins: 'приёмом', pre: 'приёме',
      nomPl: 'приёмы', genPl: 'приёмов', datPl: 'приёмам', accPl: 'приёмы', insPl: 'приёмами', prePl: 'приёмах',
    },
    service: {
      g: 'f',
      nom: 'процедура', gen: 'процедуры', dat: 'процедуре', acc: 'процедуру', ins: 'процедурой', pre: 'процедуре',
      nomPl: 'процедуры', genPl: 'процедур', datPl: 'процедурам', accPl: 'процедуры', insPl: 'процедурами', prePl: 'процедурах',
    },
    client: {
      g: 'm',
      nom: 'пациент', gen: 'пациента', dat: 'пациенту', acc: 'пациента', ins: 'пациентом', pre: 'пациенте',
      nomPl: 'пациенты', genPl: 'пациентов', datPl: 'пациентам', accPl: 'пациентов', insPl: 'пациентами', prePl: 'пациентах',
    },
    place: {
      g: 'f',
      nom: 'клиника', gen: 'клиники', dat: 'клинике', acc: 'клинику', ins: 'клиникой', pre: 'клинике',
      nomPl: 'клиники', genPl: 'клиник', datPl: 'клиникам', accPl: 'клиники', insPl: 'клиниками', prePl: 'клиниках',
    },
  },
};

// Фразы, где рядом с термином стоит согласуемое слово - прилагательное или глагол
// в прошедшем времени. Выводить их правилом нельзя: «Новая запись» → «Новый приём»,
// «Запись отменена» → «Приём отменён». Набор ключей у всех вертикалей одинаков,
// это проверяет тест
export const PHRASES = {
  barbershop: {
    'booking.new': 'Новая запись',
    'booking.cancelled': 'Запись отменена',
    'booking.movedOut': 'Запись ушла к другому мастеру',
    'booking.movedIn': 'Перенесена запись к вам',
    'booking.moved': 'Запись перенесена',
    'booking.movedOutPlace': 'Запись ушла с точки',
    'booking.movedInPlace': 'Запись перенесена на точке',
    'client.missedLast': 'Пропустил последнюю запись - стоит позвонить',
  },
  clinic: {
    'booking.new': 'Новый приём',
    'booking.cancelled': 'Приём отменён',
    'booking.movedOut': 'Приём ушёл к другому врачу',
    'booking.movedIn': 'Перенесён приём к вам',
    'booking.moved': 'Приём перенесён',
    'booking.movedOutPlace': 'Приём ушёл с точки',
    'booking.movedInPlace': 'Приём перенесён на точке',
    'client.missedLast': 'Пропустил последний приём - стоит позвонить',
  },
};

// Незнакомая вертикаль не ломает экран и не оставляет пустых надписей - она говорит
// словами барбершопа. То же правило действует на каждом уровне ниже: нет термина -
// берём барбершопный, нет и там - отдаём сам ключ, чтобы пропуск было видно глазами,
// а не по пустому месту
export function resolveVertical(vertical) {
  return typeof vertical === 'string' && TERMS[vertical] ? vertical : DEFAULT_VERTICAL;
}

export function term(vertical, path) {
  const [key, form = 'nom'] = String(path ?? '').split('.');
  const entry = TERMS[resolveVertical(vertical)]?.[key] ?? TERMS[DEFAULT_VERTICAL][key];
  const value = entry?.[form];
  return typeof value === 'string' ? value : String(path ?? '');
}

export function phrase(vertical, key) {
  const value = PHRASES[resolveVertical(vertical)]?.[key] ?? PHRASES[DEFAULT_VERTICAL][key];
  return typeof value === 'string' ? value : String(key ?? '');
}

// Русское склонение числительного: 1 приём, 2 приёма, 5 приёмов. Отдельных данных не
// требует - это именительный, родительный единственного и родительный множественного,
// они уже есть в формах. Одиннадцать и двенадцать - те места, где наивное правило
// «последняя цифра» врёт
export function countedTerm(vertical, key, n) {
  const value = Math.abs(Number(n) || 0);
  const tens = value % 100;
  const ones = value % 10;
  if (ones === 1 && tens !== 11) return term(vertical, `${key}.nom`);
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return term(vertical, `${key}.gen`);
  return term(vertical, `${key}.genPl`);
}

// Ответ роута GET /tenant/appearance. Наружу уходят только вертикаль и слова: ни
// названия арендатора, ни доменов, ни чего-либо про его клиентов. Копия глубокая -
// иначе правка ответа в одном запросе испортила бы словарь для всех следующих
export function appearanceFor(vertical) {
  const resolved = resolveVertical(vertical);
  return {
    vertical: resolved,
    terms: structuredClone(TERMS[resolved]),
    phrases: structuredClone(PHRASES[resolved]),
  };
}
