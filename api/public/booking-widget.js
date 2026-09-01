// Виджет записи для сайта клиента (01.09.2026).
//
// Зачем отдельным файлом. Форма записи Алихана вросла в его лендинг: разметка,
// стили и логика перемешаны на 2145 строк. Скопировать её на сайт клиники значило
// бы завести вторую копию, которая разойдётся с первой на первой же правке. Здесь
// вся форма собирается скриптом в указанный контейнер, а сайт остаётся своим:
// он даёт только цвета и шрифты через CSS-переменные.
//
// Подключение на сайте клиента - две строки:
//   <div id="zapis"></div>
//   <script type="module">
//     import { mountBookingWidget } from '.../booking-widget.js';
//     mountBookingWidget('#zapis', { api: '...', tenantKey: 'karina' });
//   </script>
//
// Заведение определяется ключом, а не доменом: сайты клиентов живут на общем
// адресе GitHub Pages, и по домену их не различить (миграция 067).
const DAYS_AHEAD = 21;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `${Number(n).toLocaleString('ru-RU')} ₽`;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function humanDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

// Телефон человек вводит как привык: со скобками, пробелами, через 8 или +7.
// Приводим к одному виду здесь, чтобы сервер не разбирался в вариантах записи
function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return `+7${digits.slice(1)}`;
  if (digits.length === 10) return `+7${digits}`;
  return null;
}

export function mountBookingWidget(target, options) {
  const root = typeof target === 'string' ? document.querySelector(target) : target;
  if (!root) return null;
  const api = String(options.api).replace(/\/+$/, '');
  const key = options.tenantKey;
  const url = (path, params = {}) => {
    const u = new URL(`${api}${path}`);
    u.searchParams.set('t', key);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((item) => u.searchParams.append(k, item));
      else if (v != null) u.searchParams.set(k, v);
    }
    return u.toString();
  };

  const state = { masters: [], terms: null, serviceId: null, masterId: null, date: null, time: null, slots: [] };

  root.innerHTML = `<div class="bw" data-bw>
    <div class="bw-step" data-step="service"><div class="bw-title">Выберите услугу</div><div class="bw-options" data-services></div></div>
    <div class="bw-step" data-step="master" hidden><div class="bw-title">Выберите специалиста</div><div class="bw-options" data-masters></div></div>
    <div class="bw-step" data-step="date" hidden><div class="bw-title">Выберите день</div><div class="bw-days" data-days></div></div>
    <div class="bw-step" data-step="time" hidden><div class="bw-title">Свободное время</div><div class="bw-slots" data-slots></div></div>
    <div class="bw-step" data-step="who" hidden>
      <div class="bw-title">Ваши контакты</div>
      <div class="bw-fields">
        <label class="bw-field"><span>Имя</span><input type="text" data-name autocomplete="name" placeholder="Как к вам обращаться"></label>
        <label class="bw-field"><span>Телефон</span><input type="tel" data-phone autocomplete="tel" placeholder="+7 900 000-00-00"></label>
      </div>
      <div class="bw-summary" data-summary></div>
      <button type="button" class="bw-submit" data-submit>Записаться</button>
      <div class="bw-error" data-error hidden></div>
    </div>
    <div class="bw-done" data-done hidden></div>
  </div>`;

  const el = (name) => root.querySelector(`[data-${name}]`);
  const showStep = (name, visible) => { root.querySelector(`[data-step="${name}"]`).hidden = !visible; };

  function servicesOfMasters() {
    const map = new Map();
    for (const master of state.masters) {
      for (const service of master.services ?? []) {
        const found = map.get(service.id);
        // Цена и длительность зависят от специалиста, поэтому в списке услуг
        // показываем «от» - точную цену человек увидит после выбора врача
        if (!found || service.price < found.price) map.set(service.id, { ...service });
      }
    }
    return [...map.values()];
  }

  function renderServices() {
    const services = servicesOfMasters();
    el('services').innerHTML = services.map((s) => `
      <button type="button" class="bw-option" data-service="${esc(s.id)}">
        <span class="bw-option-name">${esc(s.name)}</span>
        <span class="bw-option-meta">от ${money(s.price)} · ${s.durationMin} мин</span>
      </button>`).join('');
  }

  function renderMasters() {
    const list = state.masters.filter((m) => (m.services ?? []).some((s) => s.id === state.serviceId));
    el('masters').innerHTML = list.map((m) => {
      const service = m.services.find((s) => s.id === state.serviceId);
      return `<button type="button" class="bw-option" data-master="${esc(m.id)}">
        <span class="bw-option-name">${esc(m.name)}</span>
        <span class="bw-option-meta">${money(service.price)} · ${service.durationMin} мин</span>
      </button>`;
    }).join('');
    showStep('master', list.length > 0);
    // Специалист один - выбирать не из чего, шаг пропускаем
    if (list.length === 1) selectMaster(list[0].id, true);
  }

  function renderDays() {
    const today = new Date();
    const days = [];
    for (let i = 0; i < DAYS_AHEAD; i += 1) {
      const d = new Date(today.getTime() + i * 86400e3);
      days.push(isoDate(d));
    }
    el('days').innerHTML = days.map((iso) => `
      <button type="button" class="bw-day" data-day="${iso}">${humanDate(iso)}</button>`).join('');
    showStep('date', true);
  }

  async function renderSlots() {
    const box = el('slots');
    box.innerHTML = '<span class="bw-note">Смотрим свободное время...</span>';
    showStep('time', true);
    try {
      const res = await fetch(url('/free-slots', { masterId: state.masterId, serviceId: [state.serviceId], date: state.date }));
      const data = await res.json();
      state.slots = data.slots ?? [];
      // Пустой день - это ответ, а не ошибка: человек должен видеть, что тут
      // занято, и выбрать другой, а не гадать, загрузилось ли
      box.innerHTML = state.slots.length
        ? state.slots.map((t) => `<button type="button" class="bw-slot" data-slot="${t}">${t}</button>`).join('')
        : '<span class="bw-note">На этот день свободного времени нет - выберите другой</span>';
    } catch {
      box.innerHTML = '<span class="bw-note">Не удалось загрузить свободное время. Обновите страницу</span>';
    }
  }

  function renderSummary() {
    const master = state.masters.find((m) => m.id === state.masterId);
    const service = master?.services.find((s) => s.id === state.serviceId);
    el('summary').innerHTML = `${esc(service?.name ?? '')} · ${esc(master?.name ?? '')}<br>${humanDate(state.date)} в ${state.time} · ${money(service?.price ?? 0)}`;
    showStep('who', true);
  }

  function selectMaster(id, silent = false) {
    state.masterId = id;
    root.querySelectorAll('[data-master]').forEach((b) => b.classList.toggle('is-active', b.dataset.master === id));
    if (!silent) { state.date = null; state.time = null; }
    renderDays();
  }

  root.addEventListener('click', (event) => {
    const service = event.target.closest('[data-service]');
    if (service) {
      state.serviceId = service.dataset.service;
      state.masterId = null; state.date = null; state.time = null;
      root.querySelectorAll('[data-service]').forEach((b) => b.classList.toggle('is-active', b === service));
      showStep('date', false); showStep('time', false); showStep('who', false);
      renderMasters();
      return;
    }
    const master = event.target.closest('[data-master]');
    if (master) { selectMaster(master.dataset.master); showStep('time', false); showStep('who', false); return; }
    const day = event.target.closest('[data-day]');
    if (day) {
      state.date = day.dataset.day; state.time = null;
      root.querySelectorAll('[data-day]').forEach((b) => b.classList.toggle('is-active', b === day));
      showStep('who', false);
      renderSlots();
      return;
    }
    const slot = event.target.closest('[data-slot]');
    if (slot) {
      state.time = slot.dataset.slot;
      root.querySelectorAll('[data-slot]').forEach((b) => b.classList.toggle('is-active', b === slot));
      renderSummary();
    }
  });

  el('submit').addEventListener('click', async () => {
    const button = el('submit');
    const error = el('error');
    const name = el('name').value.trim();
    const phone = normalizePhone(el('phone').value);
    error.hidden = true;
    if (!name) { error.textContent = 'Напишите, как к вам обращаться'; error.hidden = false; return; }
    if (!phone) { error.textContent = 'Проверьте номер телефона'; error.hidden = false; return; }

    button.disabled = true;
    button.textContent = 'Записываем...';
    try {
      const res = await fetch(url('/bookings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          masterId: state.masterId,
          serviceIds: [state.serviceId],
          date: state.date,
          startTime: state.time,
          clientName: name,
          clientPhone: phone,
          channel: 'client',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'booking_failed');
      showDone(data);
    } catch (err) {
      // Занятое время - самый частый и самый понятный отказ: кто-то успел
      // записаться, пока человек заполнял форму
      error.textContent = /slot_taken|schedule_blocked/.test(String(err.message))
        ? 'Это время только что заняли. Выберите другое, пожалуйста'
        : 'Не удалось записаться. Попробуйте ещё раз или позвоните нам';
      error.hidden = false;
      if (/slot_taken|schedule_blocked/.test(String(err.message))) renderSlots();
    } finally {
      button.disabled = false;
      button.textContent = 'Записаться';
    }
  });

  function showDone(data) {
    root.querySelectorAll('.bw-step').forEach((s) => { s.hidden = true; });
    const done = el('done');
    const when = `${humanDate(state.date)} в ${state.time}`;
    // Три честных состояния вместо одного бодрого. Человек, который уже в боте,
    // не должен получать предложение подключиться второй раз, а тот, у кого бота
    // у заведения нет вовсе, не должен видеть кнопку в никуда
    const bot = data.bot;
    const botBlock = bot?.linked
      ? '<p class="bw-done-note">Подтверждение и напоминания придут вам в Telegram</p>'
      : bot?.link
        ? `<a class="bw-bot" href="${esc(bot.link)}" target="_blank" rel="noopener">Подтвердить запись в Telegram</a>
           <p class="bw-done-note">Там же придут напоминания, и можно будет перенести или отменить визит</p>`
        : '';
    done.innerHTML = `<div class="bw-done-title">Вы записаны</div>
      <div class="bw-done-when">${when}</div>
      ${botBlock}`;
    done.hidden = false;
  }

  (async function load() {
    try {
      const [mastersRes, appearanceRes] = await Promise.all([
        fetch(url('/public/masters')),
        fetch(url('/tenant/appearance')),
      ]);
      state.masters = await mastersRes.json();
      state.terms = await appearanceRes.json().catch(() => null);
      const masterWord = state.terms?.terms?.master?.nomPl;
      if (masterWord) root.querySelector('[data-step="master"] .bw-title').textContent = `Выберите специалиста`;
      renderServices();
    } catch {
      root.innerHTML = '<p class="bw-note">Не удалось загрузить запись. Обновите страницу или позвоните нам</p>';
    }
  })();

  return { state };
}

// Автомонтирование: сайту клиента достаточно поставить контейнер с атрибутами и
// подключить скрипт. Никакого кода на его стороне - подключение нового клиента
// сводится к двум строкам разметки.
//
//   <div data-booking-widget data-api="https://..." data-tenant="karina"></div>
//   <script type="module" src="https://.../widget.js"></script>
for (const node of document.querySelectorAll('[data-booking-widget]')) {
  mountBookingWidget(node, { api: node.dataset.api, tenantKey: node.dataset.tenant });
}
