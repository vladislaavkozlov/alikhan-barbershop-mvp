// Окно 9, часть 1 - визуальное поведение статического макета.
// Клик по записи в календаре заполняет ЕДИНУЮ карточку записи данными из data-атрибутов
// этого конкретного блока и открывает её. Никакого fetch, никакого реального расчёта -
// только текст полей на экране, как и требует промпт окна.

// Длительность услуги ПО МАСТЕРУ (правка Влада 28.07.2026). Реальная схема БД уже
// поддерживает это (таблица master_services, разд.12 п.7,8) - сейчас там одинаковые
// цифры на всех трёх мастеров (см. миграцию 002_schema.sql), реальной дифференциации
// "этот мастер быстрее/медленнее" ещё нет. Здесь та же стартовая раскладка - источник
// api/migrations/002_schema.sql (services.duration_min), не выдумано. Владелец может
// переопределить число для конкретного мастера во вкладке "Сотрудники" - хранится
// только в памяти этой вкладки браузера (window.*), не сохраняется на сервер, как и
// весь остальной макет.
window.MASTER_SERVICE_DURATION = {};
(function seedDurations() {
  const base = {
    'Стрижка': 40, 'Борода': 30, 'Комплекс стрижка+борода': 60, 'Бритьё': 40,
    'Фирменная окантовка': 30, 'Тонировка седых волос': 60, 'Воск': 15, 'СПА уход': 60,
  };
  ['Алиовсад', 'Мамедхан', 'Елизавета'].forEach((master) => {
    window.MASTER_SERVICE_DURATION[master] = { ...base };
  });
})();


// Показывает длительность услуги для мастера открытой сейчас записи. service может
// прийти как "Стрижка · 2000₽" (из data-service календаря) или просто "Стрижка"
// (из чекбокса в блоке "Изменить услугу") - берём часть до " · " в обоих случаях.
function updateDuration(master, service) {
  const el = document.getElementById('bk-duration');
  if (!el) return;
  const serviceName = (service || '').split(' · ')[0].trim();
  const minutes = master && window.MASTER_SERVICE_DURATION[master] ? window.MASTER_SERVICE_DURATION[master][serviceName] : null;
  el.value = serviceName && minutes ? `${minutes} мин` : '—';
}

// Клик по чекбоксу услуги в блоке "Изменить или добавить услугу этой записи" -
// пересчитывает длительность под мастера ЭТОЙ записи (bk-master), не только комиссию.
function pickServiceForBooking(input) {
  if (!input.checked) return;
  const label = input.closest('.service-check');
  const name = label ? label.querySelector('.sc-name').textContent.trim() : '';
  const master = document.getElementById('bk-master');
  updateDuration(master ? master.value : '', name);
}
function openBooking(el) {
  // Подсветка на календаре: снимаем выделение с прежде выбранной карточки (если была)
  // и подсвечиваем ту, по которой кликнули сейчас - чтобы было видно, какая именно
  // запись сейчас открыта в карточке ниже.
  document.querySelectorAll('.appt--selected').forEach((n) => {
    if (n !== el) n.classList.remove('appt--selected');
  });
  el.classList.add('appt--selected');

  const d = el.dataset;
  const panel = document.getElementById('bd-1');
  const setVal = (id, val) => {
    const node = document.getElementById(id);
    if (node) node.value = val ?? '';
  };
  // на случай если карточка осталась в редактируемом состоянии после "+ Новая запись" -
  // обычная запись всегда снова readonly и без баннера "без предварительной записи"
  ['bk-client', 'bk-phone', 'bk-service', 'bk-master'].forEach((id) => {
    const node = document.getElementById(id);
    if (node) node.readOnly = true;
  });
  const wb = document.getElementById('bk-walkin-banner');
  if (wb) wb.hidden = true;

  setVal('bk-client', d.client);
  setVal('bk-phone', d.phone);
  setVal('bk-master', d.master);
  setVal('bk-service', d.service);
  setVal('bk-planned', d.planned);

  const radio = document.getElementById('st-' + (d.status || 'wait'));
  if (radio) radio.checked = true;

  // Чекбокс "Клиент подтвердил запись" (bconfirm) - на crm-owner.html убран Окном 36
  // (06.08.2026): роута на запись bookings.client_confirmed не существует, показывать
  // интерактивный элемент без реального сохранения было бы декоративным. На
  // crm-admin.html/crm-master.html чекбокс жив (это окно их не касалось) - getElementById
  // безопасно вернёт null на owner-странице, блок no-op, как и для остальных
  // опциональных полей в этой функции.
  const confirmBox = document.getElementById('bconfirm');
  if (confirmBox) confirmBox.checked = d.confirmed === 'true';

  // Правка Окна 36 (06.08.2026, была 03.08.2026): статус визита теперь пишет радио
  // выше (wireBookingStatusRadios, assets/crm-auth.js), не отдельная кнопка - id
  // брони и текущий РЕАЛЬНЫЙ статус (planned/done/no_show, не отображаемый
  // wait/came/no) кладём на сам bd-1, чтобы обработчик знал, что сохранять.
  if (panel) {
    panel.dataset.bookingId = d.id || '';
    panel.dataset.bookingMasterId = d.masterId || '';
    panel.dataset.realStatus = d.realStatus || 'planned';
    panel.dataset.noshowStreak = d.noshowStreak || '0';
    panel.dataset.requiresPrepayment = d.requiresPrepayment || 'false';
  }
  updateNoShowUi();
  // "Добавить услугу к записи" (08.08.2026, assets/crm-booking-status.js
  // wireBookingServiceEdit) - опционально: crm-master.html/crm-admin.html/
  // crm-owner.html все получили этот блок в одном окне, но optional chaining на
  // случай примера-заглушки без реального d.id (d.serviceIds тогда undefined).
  window.renderBookingServiceEdit?.(d.masterId, (d.serviceIds || '').split(',').filter(Boolean));
  // "Удалить запись" (08.08.2026, assets/crm-booking-status.js wireBookingDelete) -
  // тот же приём optional chaining, что и у renderBookingServiceEdit строкой выше:
  // на crm-master.html блока нет (мастер записи не удаляет), тихий no-op.
  window.renderBookingDeleteRow?.();
  // "Фактическая сумма" (08.08.2026, assets/crm-booking-status.js
  // wireBookingActualPrice) - тот же приём optional chaining, d.actualPrice пустой
  // на "" (data-атрибут без значения), а не null/undefined - renderBookingActualPrice
  // сам приводит к input.value = '' в обоих случаях.
  window.renderBookingActualPrice?.(d.actualPrice || null);

  updateCommission(d.master, d.service);
  updateDuration(d.master, d.service);

  // Заголовок карточки (сворачиваемый <summary>) всегда показывает, ЧЬЮ запись
  // сейчас видно - без этого, проскроллив вниз к самой карточке, календарь с подсветкой
  // уже не виден и непонятно, на какое время открыта запись (правка Влада 28.07.2026).
  const now = document.getElementById('bd-now');
  if (now) now.textContent = `${d.client || ''} · ${d.service || ''} · ${d.planned || ''}${d.master ? ' (' + d.master + ')' : ''}`;

  const comment = document.getElementById('bk-comment');
  if (comment) comment.value = d.comment || '';

  if (panel) {
    panel.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Русское склонение числительного - "1 неявка" / "2 неявки" / "5 неявок".
function ruPlural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// Правка 03.08.2026: кнопка "Клиент не пришёл" (window.toggleNoShow, assets/crm-auth.js)
// заменила декоративное "Фактическое время прихода" - это единственное место, которое
// рисует её текущее состояние (label кнопки + баннер реальной истории неявок клиента).
// ВАЖНО (Окно 36, 06.08.2026): на crm-owner.html кнопки bk-noshow-btn больше нет
// (заменена радио-статусом, assets/crm-auth.js wireBookingStatusRadios) - `btn` там
// будет null и блок ниже безопасно no-op, как и раньше было для страниц без кнопки.
// На crm-admin.html/crm-master.html кнопка жива, это окно их не касалось.
// Вызывается из openBooking() и из toggleNoShow()/обработчика радио после PATCH,
// чтобы не перезагружать страницу для отражения нового состояния.
function updateNoShowUi() {
  const panel = document.getElementById('bd-1');
  if (!panel) return;
  const btn = document.getElementById('bk-noshow-btn');
  if (btn) {
    const isNoShow = panel.dataset.realStatus === 'no_show';
    btn.textContent = isNoShow ? 'Отменить отметку неявки' : 'Клиент не пришёл';
  }
  const banner = document.getElementById('bk-noshow-banner');
  if (banner) {
    const streak = parseInt(panel.dataset.noshowStreak, 10) || 0;
    if (streak > 0) {
      banner.hidden = false;
      const prepayNote = panel.dataset.requiresPrepayment === 'true' ? ' Действует правило предоплаты для следующей записи.' : '';
      const textEl = banner.querySelector('span:last-child');
      if (textEl) {
        textEl.textContent = `У этого клиента ${streak} ${ruPlural(streak, 'неявка', 'неявки', 'неявок')} без предупреждения.${prepayNote}`;
      }
    } else {
      banner.hidden = true;
    }
  }
}

// Комиссия мастера за запись (Окно 10, разд.17.3 ТЗ - реальная формула, не
// единый % на всех). Владелец (Алиовсад) себе комиссию не платит - вся сумма услуги
// и так его - поэтому для него поле показывает пояснение, а не сумму. Мамедхан -
// тоже 100% (не владелец, но подтверждено Алиханом отдельно). Елизавета - 40%
// (её базовая ставка по умолчанию, реальную владелец редактирует в карточке
// сотрудника - это поле здесь только иллюстрация одного числа в интерфейсе,
// настоящий расчёт по живым данным делает crm-auth.js).
const MASTER_COMMISSION_PCT = { 'Мамедхан': 100, 'Елизавета': 40 };
function updateCommission(master, service) {
  const input = document.getElementById('bk-commission');
  const note = document.getElementById('bk-commission-note');
  if (!input) return;
  if (master === 'Алиовсад') {
    input.value = 'Не начисляется';
    if (note) note.textContent = '';
    return;
  }
  const priceMatch = (service || '').match(/([\d\s]+)\s*₽/);
  const price = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, ''), 10) : null;
  const pct = MASTER_COMMISSION_PCT[master] ?? null;
  if (price && pct != null) {
    const commission = Math.round((price * pct) / 100);
    input.value = `${commission} ₽`;
    const editNote = master === 'Елизавета' ? ' - её ставку меняет владелец в карточке сотрудника' : '';
    if (note) note.textContent = `${pct}% от ${price}₽ (подтверждено Алиханом)${editNote}`;
  } else {
    input.value = '—';
    if (note) note.textContent = 'Выберите мастера, чтобы увидеть комиссию';
  }
}

// Кнопка "+ Добавить перерыв" - добавляет новую редактируемую строку перерыва рядом
// с существующими (ничего не сохраняет, чисто DOM). Кнопка "✕" на каждой строке
// (включая новые) убирает её через inline-обработчик this.closest('.break-row').remove().
function addBreakRow(btn) {
  const list = btn.previousElementSibling;
  if (!list || !list.classList.contains('breaks-list')) return;
  const row = document.createElement('div');
  row.className = 'break-row';
  row.innerHTML = `
    <div class="field"><label>Перерыв с</label><input type="text" value="15:00"></div>
    <div class="field"><label>до</label><input type="text" value="16:00"></div>
    <span class="note">новый - впишите время</span>
    <button class="remove-x" type="button" aria-label="Убрать перерыв" onclick="this.closest('.break-row').remove()">✕</button>
  `;
  list.appendChild(row);
}


// Добавляет комментарий в ленту (история по клиенту, не только текущая запись).
// Автор - заглушка "вы", т.к. в макете нет настоящей авторизации.
function addComment(btn) {
  const input = document.getElementById('bk-comment-new');
  const thread = document.getElementById('bk-comment-thread');
  if (!input || !thread || !input.value.trim()) return;
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const item = document.createElement('div');
  item.className = 'comment-item';
  const meta = document.createElement('div');
  meta.className = 'ci-meta';
  meta.textContent = `${dd}.${mm}.${now.getFullYear()} · вы`;
  const text = document.createElement('div');
  text.className = 'ci-text';
  text.textContent = input.value.trim();
  item.appendChild(meta);
  item.appendChild(text);
  thread.appendChild(item);
  input.value = '';
}

// "+ Добавить отпуск" - аналог addBreakRow, но с датами вместо времени и без
// дефолтного примера, потому что отпуск не привязан к конкретному повторяющемуся часу дня.
function addVacationRow(btn) {
  const list = btn.previousElementSibling;
  if (!list || !list.classList.contains('breaks-list')) return;
  const row = document.createElement('div');
  row.className = 'break-row';
  row.innerHTML = `
    <div class="field"><label>Отпуск с</label><input type="text" value="01.08.2026"></div>
    <div class="field"><label>по</label><input type="text" value="14.08.2026"></div>
    <span class="note">новый - впишите даты</span>
    <button class="remove-x" type="button" aria-label="Убрать отпуск" onclick="this.closest('.break-row').remove()">✕</button>
  `;
  list.appendChild(row);
}

// "✕" на строке "клиент не приходил N мес" (правка Влада 28.07.2026) - НЕ удаляет
// строку насовсем, а только прячет (display:none) и переносит в счётчик "Показать
// скрытые" рядом с списком. Так случайный клик по ✕ не теряет клиента безвозвратно -
// в реальной CRM сам клиент и его история в любом случае живут отдельно (в карточке
// клиента), это только напоминалка "нужно перезвонить", а не единственное место с данными.
function dismissRetentionRow(btn) {
  const row = btn.closest('.ra-row');
  if (!row) return;
  row.hidden = true;
  const list = row.closest('.ra-list');
  const restore = list ? list.querySelector('.ra-restore') : null;
  if (restore) {
    const count = restore.querySelector('.count');
    const hiddenCount = list.querySelectorAll('.ra-row[hidden]').length;
    if (count) count.textContent = hiddenCount;
    restore.hidden = false;
  }
  updateNotifBadge();
}

// "Показать скрытые (N)" - возвращает все спрятанные ✕ строки этого списка обратно.
function restoreRetentionRows(btn) {
  const restore = btn.closest('.ra-restore');
  const list = restore ? restore.closest('.ra-list') : null;
  if (!list) return;
  list.querySelectorAll('.ra-row[hidden]').forEach((row) => { row.hidden = false; });
  restore.hidden = true;
  updateNotifBadge();
}

// Колокольчик в шапке (правка Влада 28.07.2026) - список "не приходили" убран с первого
// экрана, чтобы не встречать негативом при входе, но остаётся в один клик доступным
// как всплывающая панель. Счётчик на колокольчике = сколько строк сейчас реально видно
// (не скрыто через ✕), обновляется при каждом dismiss/restore.
function toggleRetentionPanel(btn) {
  const panel = document.getElementById('retention-panel');
  if (panel) panel.classList.toggle('open');
}
function closeRetentionPanel(btn) {
  const panel = btn.closest('.retention-alert');
  if (panel) panel.classList.remove('open');
}
function updateNotifBadge() {
  const panel = document.getElementById('retention-panel');
  const badge = document.querySelector('.notif-badge');
  if (!panel || !badge) return;
  badge.textContent = panel.querySelectorAll('.ra-row:not([hidden])').length;
}
// Пересчитываем счётчик на колокольчике сразу при загрузке - число в разметке легко
// разойдётся со списком примеров при следующей правке, а так оно всегда верное.
updateNotifBadge();

// Кнопка "Показать" в панели "Задать период" ("Моя зарплата" мастера,
// crm-master.html) была здесь как глобальная onclick-функция (mockup-crm.js не
// модуль, не имеет доступа к fetchJson/сессии). Окно 37 (06.08.2026, Задача 2)
// перенесло реальный расчёт в assets/crm-auth.js (уже ES-модуль, уже знает
// staff.id и токен сессии) - там же, где Блок В (owner/admin) уже делает то же
// самое своим отдельным обработчиком. calcCustomPayroll здесь больше не нужна -
// единственный вызов (crm-master.html) переведён на wireMasterPayrollPeriod.

// Кастомный дропдаун "Закреплён за мастером" (правка 30.07.2026) - заменяет нативный
// <select>, у которого список опций красит ОС, а не тема сайта (Алихан заметил это на
// живом показе на телефоне). Один открытый список за раз - открытие нового закрывает предыдущий.
function toggleCustomSelect(trigger) {
  const wrap = trigger.closest('.custom-select');
  if (!wrap) return;
  const alreadyOpen = wrap.classList.contains('open');
  document.querySelectorAll('.custom-select.open').forEach(closeCustomSelect);
  if (!alreadyOpen) openCustomSelect(wrap);
}
function openCustomSelect(wrap) {
  wrap.classList.add('open');
  const list = wrap.querySelector('.custom-select-list');
  if (list) list.hidden = false;
}
function closeCustomSelect(wrap) {
  wrap.classList.remove('open');
  const list = wrap.querySelector('.custom-select-list');
  if (list) list.hidden = true;
}
function pickCustomSelectOption(option) {
  const wrap = option.closest('.custom-select');
  const trigger = wrap ? wrap.querySelector('.custom-select-trigger') : null;
  if (!wrap || !trigger) return;
  wrap.querySelectorAll('.custom-select-option').forEach((o) => o.classList.remove('selected'));
  option.classList.add('selected');
  trigger.textContent = option.textContent;
  wrap.dataset.value = option.dataset.value || option.textContent;
  closeCustomSelect(wrap);
  // Правка 03.08.2026: нужно реальным слушателям (time-picker перерывов/графика в
  // assets/crm-auth.js) знать, что значение поменялось - раньше событие никто не
  // слушал ("Закреплён за мастером" читает wrap.dataset.value по кнопке "Сохранить").
  wrap.dispatchEvent(new CustomEvent('customselect:change', { bubbles: true, detail: { value: wrap.dataset.value } }));
}
// Свой date-picker (Окно 16, 03.08.2026) - по образцу .custom-select выше, но с
// месячной сеткой вместо плоского списка. Заменяет нативный <input type="date">
// (браузер/ОС рисует свой календарь мимо темы сайта - та же болезнь, что раньше
// была у <select>). Панель рендерится лениво при первом открытии, не сразу при
// построении - календарная сетка дороже плоского списка времени, а виджетов на
// странице десятки (см. КОНВЕНЦИЯ-ВСПЛЫВАЮЩИЕ-ЭЛЕМЕНТЫ.md).
const DATE_WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DATE_MONTH_LABEL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
function toggleCustomDate(trigger) {
  const wrap = trigger.closest('.custom-date');
  if (!wrap) return;
  const alreadyOpen = wrap.classList.contains('open');
  document.querySelectorAll('.custom-date.open').forEach(closeCustomDate);
  document.querySelectorAll('.custom-select.open').forEach(closeCustomSelect);
  if (!alreadyOpen) openCustomDate(wrap);
}
function openCustomDate(wrap) {
  wrap.classList.add('open');
  const panel = wrap.querySelector('.custom-date-panel');
  if (!panel) return;
  panel.hidden = false;
  if (!panel.dataset.rendered) renderCustomDateCalendar(wrap);
}
function closeCustomDate(wrap) {
  wrap.classList.remove('open');
  const panel = wrap.querySelector('.custom-date-panel');
  if (panel) panel.hidden = true;
}
// Задача D (Окно 53) - "подсветка сегодня" для вида "День": своей сетки дней у
// Дня нет (одна выбранная дата, не грид), поэтому маркер идёт сюда - в календарь-
// попап date-picker'а, через который День (и любая другая форма с датой) выбирает
// число. Локальная дата, не UTC (тот же приём, что todayStr() в crm-calendar.js) -
// new Date().toISOString() съезжает на день не в UTC-поясе (см. api/lib/db.js).
function customDateCellsHtml(wrap, year, month) {
  const selected = wrap.dataset.value;
  const minDate = wrap.dataset.minDate || null; // "YYYY-MM-DD" - см. buildDateWidgetHtml
  const pad2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // 0=Пн
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let cells = '';
  for (let i = 0; i < firstWeekday; i++) cells += '<span class="custom-date-cell custom-date-cell--empty"></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
    const selectedCls = dateStr === selected ? ' selected' : '';
    const todayCls = dateStr === todayLocal ? ' is-today' : '';
    if (minDate && dateStr < minDate) {
      cells += `<span class="custom-date-cell custom-date-cell--disabled${todayCls}" data-date="${dateStr}">${day}</span>`;
    } else {
      cells += `<button type="button" class="custom-date-cell${selectedCls}${todayCls}" onclick="pickCustomDateDay(this)" data-date="${dateStr}">${day}</button>`;
    }
  }
  return cells;
}
function renderCustomDateCalendar(wrap) {
  const panel = wrap.querySelector('.custom-date-panel');
  if (!panel) return;
  const year = Number(wrap.dataset.viewYear);
  const month = Number(wrap.dataset.viewMonth); // 1-12
  panel.innerHTML = `
    <div class="custom-date-nav">
      <button type="button" class="custom-date-nav-btn" onclick="shiftCustomDateMonth(this, -1)" aria-label="Предыдущий месяц">‹</button>
      <span class="custom-date-month-label">${DATE_MONTH_LABEL[month - 1]} ${year}</span>
      <button type="button" class="custom-date-nav-btn" onclick="shiftCustomDateMonth(this, 1)" aria-label="Следующий месяц">›</button>
    </div>
    <div class="custom-date-weekdays">${DATE_WEEKDAY_SHORT.map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="custom-date-grid">${customDateCellsHtml(wrap, year, month)}</div>`;
  panel.dataset.rendered = '1';
}
// Задача E (Окно 53) - листание месяца точечно обновляет ТОЛЬКО подпись месяца и
// сетку дней, кнопки навигации (‹/›) остаются теми же узлами DOM. Раньше
// shiftCustomDateMonth звал renderCustomDateCalendar целиком - panel.innerHTML
// пересобирал ВСЕ узлы, включая нажатую кнопку "›"/"‹", отсоединяя её от документа.
// Глобальный обработчик "клик вне попапа - закрыть" (ниже, document.addEventListener
// 'click') проверяет wrap.contains(e.target) - у отсоединённого e.target это всегда
// false, попап закрывался сразу после каждого клика по стрелке.
function updateCustomDateGrid(wrap) {
  const panel = wrap.querySelector('.custom-date-panel');
  if (!panel) return;
  const year = Number(wrap.dataset.viewYear);
  const month = Number(wrap.dataset.viewMonth);
  const label = panel.querySelector('.custom-date-month-label');
  if (label) label.textContent = `${DATE_MONTH_LABEL[month - 1]} ${year}`;
  const grid = panel.querySelector('.custom-date-grid');
  if (grid) grid.innerHTML = customDateCellsHtml(wrap, year, month);
}
function shiftCustomDateMonth(navBtn, delta) {
  const wrap = navBtn.closest('.custom-date');
  if (!wrap) return;
  let year = Number(wrap.dataset.viewYear);
  let month = Number(wrap.dataset.viewMonth) + delta;
  if (month < 1) { month = 12; year -= 1; }
  if (month > 12) { month = 1; year += 1; }
  wrap.dataset.viewYear = String(year);
  wrap.dataset.viewMonth = String(month);
  updateCustomDateGrid(wrap);
}
function pickCustomDateDay(dayBtn) {
  const wrap = dayBtn.closest('.custom-date');
  const trigger = wrap ? wrap.querySelector('.custom-date-trigger') : null;
  if (!wrap || !trigger) return;
  const dateStr = dayBtn.dataset.date;
  const [y, m, d] = dateStr.split('-');
  wrap.dataset.value = dateStr;
  trigger.textContent = `${d}.${m}.${y}`;
  wrap.querySelectorAll('.custom-date-cell.selected').forEach((c) => c.classList.remove('selected'));
  dayBtn.classList.add('selected');
  closeCustomDate(wrap);
  wrap.dispatchEvent(new CustomEvent('customdate:change', { bubbles: true, detail: { value: dateStr } }));
}

document.addEventListener('click', (e) => {
  document.querySelectorAll('.custom-select.open').forEach((wrap) => {
    if (!wrap.contains(e.target)) closeCustomSelect(wrap);
  });
  document.querySelectorAll('.custom-date.open').forEach((wrap) => {
    if (!wrap.contains(e.target)) closeCustomDate(wrap);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.custom-select.open').forEach(closeCustomSelect);
    document.querySelectorAll('.custom-date.open').forEach(closeCustomDate);
  }
});
