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
    'booking.newForSlot': 'Новая запись на выбранное время',
    'booking.walkin': 'Новая запись без предзаписи',
    'booking.repeat': 'Повторная запись',
    'booking.notFound': 'запись не найдена - возможно, её уже удалили',
    'booking.cancelledCantEdit': 'запись отменена - править её нельзя, создайте новую',
    'booking.cancelledCantMove': 'запись отменена - перенести её нельзя, создайте новую',
    'booking.noRightsEdit': 'нет прав править эту запись (другая точка)',
    'booking.noRightsMove': 'нет прав переносить эту запись (другая точка)',
    'booking.overlapOther': 'на это время у мастера уже есть другая запись - выберите свободное',
    'booking.pastTimeCreate': 'нельзя записать в прошлое',
    'booking.noBookableMaster': 'Нет мастера с рабочим графиком для новой записи',
    'booking.foreignServices': 'новый мастер не оказывает часть услуг этой записи - поправьте список услуг',
    'booking.comboConflict': 'В этой записи комплекс и отдельная услуга, которая уже в него входит - снимите лишнюю галочку, иначе сохранить не получится',
    'booking.cancelled': 'Запись отменена',
    'booking.movedOut': 'Запись ушла к другому мастеру',
    'booking.movedIn': 'Перенесена запись к вам',
    'booking.moved': 'Запись перенесена',
    'booking.movedOutPlace': 'Запись ушла с точки',
    'booking.movedInPlace': 'Запись перенесена на точке',
    'client.missedLast': 'Пропустил последнюю запись - стоит позвонить',
    'msg.cancelled': 'Ваша запись {when} отменена',
    'msg.expected': 'Ждём вас {when}',
    'booking.cancelledShort': 'Запись отменена',
    'booking.deleted': 'Запись удалена',
    'booking.notInSchedule': 'Запись не найдена в расписании - возможно, её отменили',
    'booking.deleteConfirm': 'Удалить запись безвозвратно? Из статистики и зарплаты тоже пропадёт',
    'booking.deleteFailed': 'Не удалось удалить запись',
    'booking.noRightsChange': 'нет прав менять эту запись (другая точка)',
    'booking.notOpened': 'запись не открыта',
    'booking.outsideHours': 'Запись вне рабочих часов мастера',
    'booking.expand': 'Раскрыть запись',
    'booking.collapse': 'Свернуть запись',
    'booking.open': 'Открыть запись',
    'booking.opening': 'Открываю запись',
    'booking.created': 'запись создана',
    'booking.emptyBell': 'Новых записей нет. Всё, что было, осталось в разделе «Уведомления»',
    'booking.emptyFeed': 'Пока ни одной новой записи. Здесь появится каждая запись клиента - сразу, как её создадут на сайте или в CRM',
    'booking.saleAttached': 'К данной записи привязана продажа ({sum}), которая участвует в расчёте ЗП. Подтверждаете удаление?',
    'booking.deletedRefresh': 'Запись удалена. Обновите страницу, чтобы календарь пересчитался',
    'service.addedToBooking': 'Услуга добавлена к записи',
    'schedule.noneCantBook': 'Нет графика - клиенты не могут записаться',
    'schedule.dayOff': 'Выходной, записи не будет',
    'schedule.noBookingsThatDay': 'Записи в этот день нет',
    'schedule.breakNoBooking': 'В это время записи не будет',
    'schedule.conflictSave': 'Нельзя сохранить график: на это время уже есть записи, они перечислены ниже',
    'schedule.conflictSaveDay': 'Нельзя сохранить день: на это время уже есть записи, они перечислены ниже',
    'schedule.savedWithConflicts': 'Сохранено. На это время уже есть {count} реальных записей - в колокольчике уведомлений появилось, с кем связаться',
    'schedule.notClosedConflicts': 'не закрыто из-за записей',
    'booking.detailsTitle': 'Детали выбранного визита',
    'booking.servicesUnknown': 'Услуги по этой записи не указаны',
    'renew.waitingClient': 'Ждём клиента через {days}',
    'renew.byMasterAdvice': 'по рекомендации мастера',
    'renew.reasonRecommended': 'Мастер назвал срок, клиент согласился',
    'renew.reasonHair': 'Особенность волос или формы стрижки',
    'renew.script1': 'Назовите срок: «ваша стрижка держит форму N недель».',
    'renew.script2': 'Спросите, готов ли клиент ходить так часто ради результата.',
    'renew.script3': 'Не готов - поставьте удобный ему срок и предложите стрижку, которая хорошо выглядит весь этот срок.',
    'payroll.pickServices': 'Выберите услуги, чтобы увидеть комиссию',
    'payroll.noneAccepting': 'Пока никто из сотрудников не принимает клиентов - включите "Принимает клиентов" в разделе "Сотрудники"',
    'service.topMasterHint': 'Топ-мастер по этой услуге - на сайте клиент выбирает его отдельным тарифом',
    'service.comboOf': 'Состоит из услуг {names} - по отдельности сейчас {sum}',
    'service.priceAria': 'Цена услуги «{name}»',
    'booking.topTariff': 'запись к топ-мастеру',
    'holidays.closeAll': 'Закрыть выбранные даты всем мастерам',
    'holidays.closeCount': 'Закрыть {count} {days} всем мастерам',
    'holidays.closedTotal': 'Закрыто дней у мастеров: {count}',
    'schedule.needWorkHours': '{day}: укажите, с какого и до какого часа мастер работает',
  },
  clinic: {
    'booking.new': 'Новый приём',
    'booking.newForSlot': 'Новый приём на выбранное время',
    'booking.walkin': 'Новый приём без предзаписи',
    'booking.repeat': 'Повторный приём',
    'booking.notFound': 'приём не найден - возможно, его уже удалили',
    'booking.cancelledCantEdit': 'приём отменён - править его нельзя, создайте новый',
    'booking.cancelledCantMove': 'приём отменён - перенести его нельзя, создайте новый',
    'booking.noRightsEdit': 'нет прав править этот приём (другая точка)',
    'booking.noRightsMove': 'нет прав переносить этот приём (другая точка)',
    'booking.overlapOther': 'на это время у врача уже есть другой приём - выберите свободное',
    'booking.pastTimeCreate': 'нельзя назначить приём в прошлом',
    'booking.noBookableMaster': 'Нет врача с рабочим графиком для нового приёма',
    'booking.foreignServices': 'новый врач не оказывает часть процедур этого приёма - поправьте список процедур',
    'booking.comboConflict': 'В этом приёме комплекс и отдельная процедура, которая уже в него входит - снимите лишнюю галочку, иначе сохранить не получится',
    'booking.cancelled': 'Приём отменён',
    'booking.movedOut': 'Приём ушёл к другому врачу',
    'booking.movedIn': 'Перенесён приём к вам',
    'booking.moved': 'Приём перенесён',
    'booking.movedOutPlace': 'Приём ушёл с точки',
    'booking.movedInPlace': 'Приём перенесён на точке',
    'client.missedLast': 'Пропустил последний приём - стоит позвонить',
    'msg.cancelled': 'Ваш приём {when} отменён',
    'msg.expected': 'Ждём вас на приём {when}',
    'booking.cancelledShort': 'Приём отменён',
    'booking.deleted': 'Приём удалён',
    'booking.notInSchedule': 'Приём не найден в расписании - возможно, его отменили',
    'booking.deleteConfirm': 'Удалить приём безвозвратно? Из статистики и зарплаты тоже пропадёт',
    'booking.deleteFailed': 'Не удалось удалить приём',
    'booking.noRightsChange': 'нет прав менять этот приём (другая точка)',
    'booking.notOpened': 'приём не открыт',
    'booking.outsideHours': 'Приём вне рабочих часов врача',
    'booking.expand': 'Раскрыть приём',
    'booking.collapse': 'Свернуть приём',
    'booking.open': 'Открыть приём',
    'booking.opening': 'Открываю приём',
    'booking.created': 'приём создан',
    'booking.emptyBell': 'Новых приёмов нет. Всё, что было, осталось в разделе «Уведомления»',
    'booking.emptyFeed': 'Пока ни одного нового приёма. Здесь появится каждый приём пациента - сразу, как его создадут на сайте или в CRM',
    'booking.saleAttached': 'К данному приёму привязана продажа ({sum}), которая участвует в расчёте ЗП. Подтверждаете удаление?',
    'booking.deletedRefresh': 'Приём удалён. Обновите страницу, чтобы календарь пересчитался',
    'service.addedToBooking': 'Процедура добавлена к приёму',
    'schedule.noneCantBook': 'Нет графика - пациенты не могут записаться',
    'schedule.dayOff': 'Выходной, приёма не будет',
    'schedule.noBookingsThatDay': 'Приёмов в этот день нет',
    'schedule.breakNoBooking': 'В это время приёма не будет',
    'schedule.conflictSave': 'Нельзя сохранить график: на это время уже есть приёмы, они перечислены ниже',
    'schedule.conflictSaveDay': 'Нельзя сохранить день: на это время уже есть приёмы, они перечислены ниже',
    'schedule.savedWithConflicts': 'Сохранено. На это время уже есть {count} реальных приёмов - в колокольчике уведомлений появилось, с кем связаться',
    'schedule.notClosedConflicts': 'не закрыто из-за приёмов',
    'booking.detailsTitle': 'Детали выбранного приёма',
    'booking.servicesUnknown': 'Процедуры по этому приёму не указаны',
    'renew.waitingClient': 'Ждём пациента через {days}',
    'renew.byMasterAdvice': 'по рекомендации врача',
    'renew.reasonRecommended': 'Врач назвал срок, пациент согласился',
    'renew.reasonHair': 'Особенность случая',
    'renew.script1': 'Назовите срок: «повторный приём нужен через N недель».',
    'renew.script2': 'Спросите, готов ли пациент приходить так часто ради результата.',
    'renew.script3': 'Не готов - поставьте удобный ему срок и объясните, чем это грозит результату.',
    'payroll.pickServices': 'Выберите процедуры, чтобы увидеть комиссию',
    'payroll.noneAccepting': 'Пока никто из сотрудников не принимает пациентов - включите "Принимает пациентов" в разделе "Сотрудники"',
    'service.topMasterHint': 'Ведущий врач по этой процедуре - на сайте пациент выбирает его отдельным тарифом',
    'service.comboOf': 'Состоит из процедур {names} - по отдельности сейчас {sum}',
    'service.priceAria': 'Цена процедуры «{name}»',
    'booking.topTariff': 'приём у ведущего врача',
    'holidays.closeAll': 'Закрыть выбранные даты всем врачам',
    'holidays.closeCount': 'Закрыть {count} {days} всем врачам',
    'holidays.closedTotal': 'Закрыто дней у врачей: {count}',
    'schedule.needWorkHours': '{day}: укажите, с какого и до какого часа врач работает',
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

// Подстановка {имя} нужна там, где вокруг термина есть и согласуемое слово, и живые
// данные: «Ваша запись завтра в 14:00 отменена» → «Ваш приём завтра в 14:00 отменён».
// Разрезать такую фразу на куски нельзя - согласование потеряется
export function phrase(vertical, key, vars = null) {
  const value = PHRASES[resolveVertical(vertical)]?.[key] ?? PHRASES[DEFAULT_VERTICAL][key];
  if (typeof value !== 'string') return String(key ?? '');
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name] ?? '') : whole));
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
