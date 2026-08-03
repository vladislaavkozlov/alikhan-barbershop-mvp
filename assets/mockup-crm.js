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

// Вызывается при вводе в поле минут внутри карточки сотрудника (вкладка "Сотрудники").
// Обновляет общий объект длительностей и, если сейчас открыта карточка записи именно
// этого мастера на эту услугу, сразу пересчитывает поле "Длительность услуги" там же -
// видно вживую, без перезагрузки и без отдельного "Сохранить".
function setMasterServiceDuration(input) {
  const master = input.dataset.master;
  const service = input.dataset.svc;
  if (!master || !service) return;
  if (!window.MASTER_SERVICE_DURATION[master]) window.MASTER_SERVICE_DURATION[master] = {};
  const minutes = parseInt(input.value, 10);
  window.MASTER_SERVICE_DURATION[master][service] = minutes > 0 ? minutes : null;
  const bkMaster = document.getElementById('bk-master');
  const bkService = document.getElementById('bk-service');
  if (bkMaster) updateDuration(bkMaster.value, bkService ? bkService.value : '');
}

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
  setVal('bk-actual', d.actual || '-');

  const radio = document.getElementById('st-' + (d.status || 'wait'));
  if (radio) radio.checked = true;

  const confirmBox = document.getElementById('bconfirm');
  if (confirmBox) confirmBox.checked = d.confirmed === 'true';

  const noshowBox = document.getElementById('bnoshow');
  if (noshowBox) noshowBox.checked = d.noshow === 'true';
  const banner = document.getElementById('bk-noshow-banner');
  if (banner) banner.hidden = d.noshow !== 'true';

  updateCommission(d.master, d.service);
  updateDuration(d.master, d.service);

  // Заголовок карточки (сворачиваемый <summary>) всегда показывает, ЧЬЮ запись
  // сейчас видно - без этого, проскроллив вниз к самой карточке, календарь с подсветкой
  // уже не виден и непонятно, на какое время открыта запись (правка Влада 28.07.2026).
  const now = document.getElementById('bd-now');
  if (now) now.textContent = `${d.client || ''} · ${d.service || ''} · ${d.planned || ''}${d.master ? ' (' + d.master + ')' : ''}`;

  const comment = document.getElementById('bk-comment');
  if (comment) comment.value = d.comment || '';

  const panel = document.getElementById('bd-1');
  if (panel) {
    panel.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    if (note) note.textContent = 'Алиовсад - владелец, комиссию самому себе не платит, вся сумма услуги и так остаётся в бизнесе';
    return;
  }
  const priceMatch = (service || '').match(/([\d\s]+)\s*₽/);
  const price = priceMatch ? parseInt(priceMatch[1].replace(/\s/g, ''), 10) : null;
  const pct = MASTER_COMMISSION_PCT[master] ?? null;
  if (price && pct != null) {
    const commission = Math.round((price * pct) / 100);
    input.value = `${commission} ₽`;
    const editNote = master === 'Елизавета' ? ' - её ставку меняет владелец в карточке сотрудника' : '';
    if (note) note.textContent = `${pct}% от ${price}₽ (разд.17.3, подтверждено Алиханом)${editNote}`;
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

// Кнопка "Клиент пришёл" - подставляет текущее время браузера в фактическое время
// прихода (просто чтение локальных часов, не серверный расчёт) и переключает статус
// на "Пришёл". Поле остаётся редактируемым - мастер может поправить время вручную,
// если забыл нажать кнопку вовремя.
function markArrived(btn) {
  const input = document.getElementById('bk-actual');
  if (input) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    input.value = `${hh}:${mm}`;
  }
  const came = document.getElementById('st-came');
  if (came) came.checked = true;
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

// Кнопка "Показать" в панели "Задать период" (Расчёт ЗП - владелец/админ/мастер).
// Раньше это поле было полностью нерабочим - просто прочерк без дат, задать период
// физически было нельзя. Теперь два date-инпута реально выбираются, кнопка считывает
// выбранный диапазон и подставляет его в текст. Сама сумма всё ещё "000 ₽ пример" -
// реальных записей для расчёта в макете нет, баг был именно в невозможности задать даты.
function calcCustomPayroll(btn) {
  const panel = btn.closest('.seg-panel');
  if (!panel) return;
  const dates = panel.querySelectorAll('input[type="date"]');
  const from = dates[0] ? dates[0].value : '';
  const to = dates[1] ? dates[1].value : '';
  const amountEl = panel.querySelector('.payroll-sum .amount');
  const noteEl = panel.querySelector('.payroll-note');
  if (!from || !to) {
    if (noteEl) noteEl.textContent = 'Укажите обе даты (с и по), чтобы задать период';
    return;
  }
  const fmt = (s) => { const [y, m, day] = s.split('-'); return `${day}.${m}.${y}`; };
  if (amountEl) amountEl.innerHTML = '000 ₽ <span class="unsure">пример</span>';
  if (noteEl) noteEl.textContent = `Период ${fmt(from)}–${fmt(to)} задан. Сумма всё ещё плейсхолдер - реальных записей нет, но период теперь действительно выбирается`;
}

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
}
document.addEventListener('click', (e) => {
  document.querySelectorAll('.custom-select.open').forEach((wrap) => {
    if (!wrap.contains(e.target)) closeCustomSelect(wrap);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.custom-select.open').forEach(closeCustomSelect);
});
