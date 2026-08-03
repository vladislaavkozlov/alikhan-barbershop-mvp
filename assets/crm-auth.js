// Реальный вход в боевую базу (правка Влада 28.07.2026) поверх визуального макета
// Окна 9. Переиспользует ровно тот же контракт токена/localStorage-ключей, что уже
// работает в проде в admin.js (Окно 8) - если человек уже был залогинен через старую
// admin.html, сессия подхватится и здесь без повторного входа.
import { getMasters, getServices } from '../storage.js';
import { wireNotifications } from './crm-notifications.js';
import { renderDayCalendar } from './crm-calendar.js';

const API = window.ALIKHAN_API_URL;
const TOKEN_KEY = 'alikhan-crm:token';
const STAFF_KEY = 'alikhan-crm:staff';
const ROLE_LABELS = { owner: 'владелец', admin: 'администратор точки', master: 'мастер' };
const ROLE_PAGE = { owner: 'crm-owner.html', admin: 'crm-admin.html', master: 'crm-master.html' };

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function getStoredStaff() {
  try {
    return JSON.parse(localStorage.getItem(STAFF_KEY) || 'null');
  } catch {
    return null;
  }
}
function setSession(token, staff) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(STAFF_KEY, JSON.stringify(staff));
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(STAFF_KEY);
}

function el(id) {
  return document.getElementById(id);
}

function buildLoginGate() {
  const div = document.createElement('div');
  div.id = 'loginGate';
  div.className = 'login-gate';
  div.innerHTML = `
    <div class="login-card">
      <div class="login-brand">АЛИХАН</div>
      <p class="login-tag">CRM · вход в боевую базу</p>
      <form id="loginForm" novalidate>
        <div class="field"><label>Email</label><input id="loginEmail" type="email" required autocomplete="username"></div>
        <div class="field"><label>PIN</label><input id="loginPin" type="password" inputmode="numeric" required autocomplete="current-password"></div>
        <p id="loginError" class="login-error" hidden></p>
        <button class="btn btn-primary" type="submit">Войти</button>
      </form>
      <p class="login-hint">Настоящий вход в тестовый контур - данные реальные, точка/мастера пока тестовые (будем переносить на боевой домен Алихана отдельно). Доступы - у Влада.</p>
    </div>`;
  document.body.prepend(div);
  return div;
}

async function apiLogin(email, pin) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  });
  if (!res.ok) throw new Error('Неверный email или PIN');
  return res.json();
}

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatMoney(value) {
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`;
}

// Окно 11 (найдено Владом 30.07.2026): бронь может содержать НЕСКОЛЬКО услуг -
// b.serviceIds (см. GET /bookings, server.mjs) - сумма по всем, не одной. serviceId
// (единичное значение) остаётся страховкой на случай очень старых броней без
// booking_services. priceOf передаётся снаружи - у renderLiveProof и
// renderRevenuePeriods разные замыкания с одинаковой сигнатурой (masterId, serviceId) => price.
function bookingPrice(booking, priceOf) {
  const serviceIds = booking.serviceIds?.length ? booking.serviceIds : [booking.serviceId];
  return serviceIds.reduce((sum, id) => sum + priceOf(booking.masterId, id), 0);
}

// Живое доказательство, что это не рисунок - реальный запрос к Postgres на Amvera
// при каждой загрузке страницы. /staff и /bookings уже сами фильтруют по роли на
// сервере (Окно 8) - владелец видит всех, мастер только себя, и т.д. Заодно, если на
// странице есть блоки реальной выручки/зарплаты (id ниже) - считаем и их из тех же
// данных, вместо статичного "000 ₽ пример" (правка Влада 28.07.2026).
//
// Окно 10 (30.07.2026, разд.17.2/17.3 ТЗ): раньше цена бралась из общего /services
// (один прайс на всех) и ставка была захардкожена 0.45 для всех не-владельцев -
// оба предположения не подтвердились. Цена теперь по мастеру (/master-services,
// Елизавета дешевле Алиовсада/Мамедхана), ставка тоже по мастеру (/payroll-settings,
// master_payroll_settings: 100% у Алиовсада и Мамедхана, 40% по умолчанию у Елизаветы,
// редактируется владельцем) - обе таблицы уже фильтруют выдачу по роли на сервере.
async function renderLiveProof(staff) {
  const panel = el('liveProof');
  if (!panel) return;
  try {
    const [staffList, services, bookingsRes, masterServices, payrollRows] = await Promise.all([
      fetchJson('/staff'),
      fetchJson('/services'),
      fetchJson(`/bookings?date=${todayStr()}`),
      fetchJson('/master-services'),
      fetchJson('/payroll-settings'),
    ]);
    const bookings = bookingsRes.bookings || [];
    const bookingsNote =
      bookings.length === 0
        ? ' (тестовый контур, реальных клиентских записей ещё не вносили - это не баг)'
        : '';
    panel.innerHTML =
      `<span class="lp-dot"></span><strong>Живая боевая база (тестовый контур)</strong>` +
      `<span>сотрудников видно вам: ${staffList.length} · услуг в прайсе: ${services.length} · записей на сегодня в базе: ${bookings.length}${bookingsNote}</span>`;

    // Цена конкретного мастера на конкретную услугу - master-services покрывает все
    // пары (сид миграции 002/004), общий прайс /services - только страховка на
    // случай пары, которую почему-то не завели.
    const priceOf = (masterId, serviceId) =>
      masterServices.find((r) => r.masterId === masterId && r.serviceId === serviceId)?.price ??
      services.find((s) => s.id === serviceId)?.price ??
      0;
    // Ставка мастера (100/100/40, редактируется владельцем) - сервер уже выдал
    // только те строки, которые видны текущей роли (себя/свою точку/всех).
    const pctByMaster = new Map(payrollRows.map((r) => [r.masterId, r.pct]));
    const pctOf = (masterId) => pctByMaster.get(masterId) ?? 0;
    const ownerIds = new Set(staffList.filter((s) => s.role === 'owner').map((s) => s.id));

    // Владелец: "Выручка по точке → Все точки → День" - реальная сумма по всем
    // бронькам сегодня, зарплата - по ставке КАЖДОГО мастера (не общий %), без брони
    // владельца самому себе (он комиссию не получает).
    const revenueEl = el('rvAllDayRevenue');
    const payrollEl = el('rvAllDayPayroll');
    const netEl = el('rvAllDayNet');
    if (revenueEl && payrollEl && netEl) {
      const revenue = bookings.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
      const payrollBookings = bookings.filter((b) => !ownerIds.has(b.masterId));
      const payroll = payrollBookings.reduce(
        (sum, b) => sum + (bookingPrice(b, priceOf) * pctOf(b.masterId)) / 100,
        0
      );
      revenueEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
      payrollEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
      netEl.innerHTML = `${formatMoney(revenue - payroll)} <span class="unsure">реально</span>`;
    }

    // Мастер: "Моя зарплата → За день" - только его брони сегодня, по своей ставке.
    const myPayrollEl = el('myPayrollDay');
    if (myPayrollEl) {
      const mine = bookings.filter((b) => b.masterId === staff.id);
      const myRevenue = mine.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
      myPayrollEl.innerHTML = `${formatMoney((myRevenue * pctOf(staff.id)) / 100)} <span class="unsure">реально</span>`;
    }

    // Владелец/админ: карточка КАЖДОГО мастера в "Сотрудники" → "Расчёт ЗП → За
    // день" - реальная сумма по его же броням сегодня, своя цена и своя ставка.
    // master-1/2/3 = порядок мастеров в /staff (Алиовсад/Мамедхан/Елизавета в макете -
    // косметические имена поверх этих id).
    ['master-1', 'master-2', 'master-3'].forEach((masterId, idx) => {
      const cardEl = el(`payrollMaster${idx + 1}Day`);
      if (!cardEl) return;
      const theirs = bookings.filter((b) => b.masterId === masterId);
      const theirRevenue = theirs.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
      cardEl.innerHTML = `${formatMoney((theirRevenue * pctOf(masterId)) / 100)} <span class="unsure">реально</span>`;
    });

    // Мастер: та же "Моя зарплата", но Неделя/Месяц (раньше "000 ₽ пример") -
    // переиспользуем годовой диапазон, который уже тянет renderRevenuePeriods для
    // владельца; для роли "мастер" его там нет, поэтому свой отдельный, но лёгкий
    // (masterId сужает выборку на сервере - см. GET /bookings) запрос за год.
    const myWeekEl = el('myPayrollWeek');
    const myMonthEl = el('myPayrollMonth');
    if (myWeekEl || myMonthEl) {
      try {
        const today = todayStr();
        const yearRes = await fetchJson(`/bookings?masterId=${staff.id}&from=${periodStartStr('year')}&to=${today}`);
        const mine = yearRes.bookings || [];
        const fillMine = (targetEl, start) => {
          if (!targetEl) return;
          const rows = mine.filter((b) => b.date >= start && b.date <= today);
          const sum = rows.reduce((s, b) => s + bookingPrice(b, priceOf), 0);
          targetEl.innerHTML = `${formatMoney((sum * pctOf(staff.id)) / 100)} <span class="unsure">реально</span>`;
        };
        fillMine(myWeekEl, periodStartStr('week'));
        fillMine(myMonthEl, periodStartStr('month'));
      } catch {
        // "000 ₽ пример" останется как было - основная ошибка уже видна в панели выше
      }
    }

    // Владелец: поле "Ставка от выручки, %" в карточке Елизаветы (Окно 10,
    // разд.17.3 ТЗ) - реальное, читает и пишет master_payroll_settings. Не
    // автоматический порог 40→50%, владелец меняет число сам, когда сочтёт нужным.
    const pctInput = el('elizavetaPctInput');
    if (pctInput) {
      pctInput.value = pctOf('master-3');
      const saveBtn = el('elizavetaPctSave');
      const pctNote = el('elizavetaPctNote');
      if (saveBtn && !saveBtn.dataset.wired) {
        saveBtn.dataset.wired = '1';
        saveBtn.addEventListener('click', async () => {
          const pct = Number(pctInput.value);
          if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
            if (pctNote) pctNote.textContent = 'Ставка должна быть числом от 0 до 100';
            return;
          }
          try {
            const res = await fetch(`${API}/payroll-settings`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
              body: JSON.stringify({ masterId: 'master-3', pct }),
            });
            if (!res.ok) throw new Error(`payroll-settings → ${res.status}`);
            if (pctNote) pctNote.textContent = `Сохранено: ${pct}%. Обновите страницу, чтобы увидеть новую сумму в "Расчёт ЗП"`;
          } catch (err) {
            if (pctNote) pctNote.textContent = `Не удалось сохранить: ${err.message}`;
          }
        });
      }
    }

    // Окно 15 (02.08.2026) - календарь "День" был статичной вёрсткой-примером, не
    // видел реальные брони (баг Влада - "запись на Екатерину не видна ни у неё, ни у
    // Али"). До wireWalkIn - новые .walkin-add-btn (owner/admin) должны уже быть в
    // DOM, когда wireWalkIn их находит через querySelectorAll.
    await renderDayCalendar({ staff, staffList, services, priceOf, bookings, fetchJson });

    wirePortfolioEditors(staffList);
    ['master-1', 'master-2', 'master-3'].forEach((masterId) => wireScheduleEditor(masterId, fetchJson));
    wireWalkIn(staff, services, masterServices);
    wireMasterSelfView(staff, pctOf);
    wireMasterSelfDataTab(staff, services, masterServices, pctOf);

    await renderRevenuePeriods(priceOf, pctOf, ownerIds);
    await renderStaffPayrollPeriods(priceOf, pctOf, ownerIds);
  } catch (err) {
    panel.classList.add('lp-error');
    panel.innerHTML = `<span class="lp-dot"></span><strong>Не удалось получить живые данные</strong><span>${err.message}</span>`;
  }
}

// Задача 4 (Окно 13, 01.08.2026, разд.17.15 ТЗ) - портфолио мастера (стаж/сильные
// стороны/сертификаты/фото "до-после"), самредактируемые владельцем поля в карточке
// "Сотрудники" (crm-owner.html). Читает значения из уже загруженного /staff, пишет
// через PUT /staff/:id/portfolio (owner-only на сервере). Кнопок может не быть на
// странице (crm-admin.html/crm-master.html) - функция тогда no-op.
function wirePortfolioEditors(staffList) {
  document.querySelectorAll('.portfolio-save').forEach((btn) => {
    const masterId = btn.dataset.masterId;
    const expEl = el(`portfolioExperience-${masterId}`);
    const strEl = el(`portfolioStrengths-${masterId}`);
    const certEl = el(`portfolioCertificates-${masterId}`);
    const baEl = el(`portfolioBeforeAfter-${masterId}`);
    if (!expEl || !strEl || !certEl || !baEl) return;

    if (!btn.dataset.filled) {
      const staff = staffList.find((s) => s.id === masterId);
      if (staff) {
        expEl.value = staff.experienceText ?? '';
        strEl.value = staff.strengthsText ?? '';
        certEl.value = staff.certificatesText ?? '';
        baEl.value = staff.beforeAfterUrls ?? '';
      }
      btn.dataset.filled = '1';
    }

    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    const noteEl = el(`portfolioNote-${masterId}`);
    btn.addEventListener('click', async () => {
      try {
        const res = await fetch(`${API}/staff/${masterId}/portfolio`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            experienceText: expEl.value.trim() || null,
            strengthsText: strEl.value.trim() || null,
            certificatesText: certEl.value.trim() || null,
            beforeAfterUrls: baEl.value.trim() || null,
          }),
        });
        if (!res.ok) throw new Error(`staff/${masterId}/portfolio → ${res.status}`);
        if (noteEl) noteEl.textContent = 'Сохранено';
      } catch (err) {
        if (noteEl) noteEl.textContent = `Не удалось сохранить: ${err.message}`;
      }
    });
  });
}

// Влад (03.08.2026): "+ Добавить перерыв"/"+ Добавить отпуск" в карточке
// сотрудника (Окно 9) были рисунком - только дописывали DOM, ничего не сохраняли,
// поэтому перерыв "числился" в интерфейсе, но не блокировал онлайн-запись клиента
// (реальный баг - "у Екатерины перерыв 13-14, но можно записаться на это время").
// Реальная схема хранит перерыв ПО ДАТЕ (schedule_shifts на пару master_id+date,
// не как повторяющееся правило "каждый день 13-14") - значит и редактор владельца
// должен просить дату, не изображать вечное еженедельное расписание. Пишет
// напрямую в POST /schedule (owner/admin, сервер уже сам уведомит через
// notifications, если пересечётся с реальной записью клиента - schedule_conflict).
// Элементов может не быть на странице (crm-master.html/страницы без карточки этого
// мастера) - тогда для конкретного masterId просто no-op, тот же паттерн, что у
// wirePortfolioEditors выше.
function wireScheduleEditor(masterId, fetchJson) {
  const currentEl = el(`schedCurrent-${masterId}`);
  if (!currentEl) return;
  const dateFromEl = el(`schedDateFrom-${masterId}`);
  const saveBtn = el(`schedSave-${masterId}`);

  // crm-admin.html: только просмотр (график ставит владелец) - нет формы
  // редактирования на странице, просто показываем сегодняшние реальные данные.
  if (!dateFromEl || !saveBtn) {
    if (currentEl.dataset.wired) return;
    currentEl.dataset.wired = '1';
    fetchJson(`/schedule?masterId=${masterId}&date=${todayStr()}`)
      .then((shifts) => {
        const shift = shifts.find((s) => s.date === todayStr());
        const isFullDayOff = shift?.breaks?.some((b) => b.startTime <= '10:00' && b.endTime >= '20:00');
        if (!shift || !shift.breaks?.length) {
          currentEl.innerHTML = '<span class="note">Сегодня перерывов/выходного не задано (стандартные часы 10:00-20:00)</span>';
        } else if (isFullDayOff) {
          currentEl.innerHTML = '<div class="break-row"><span class="note" style="flex:1">Выходной весь день</span></div>';
        } else {
          currentEl.innerHTML = shift.breaks
            .map((b) => `<div class="break-row"><span class="note" style="flex:1">Перерыв ${b.startTime}–${b.endTime}</span></div>`)
            .join('');
        }
      })
      .catch((err) => {
        currentEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
      });
    return;
  }

  const dateToEl = el(`schedDateTo-${masterId}`);
  const dayOffEl = el(`schedDayOff-${masterId}`);
  const timeFieldsEl = el(`schedTimeFields-${masterId}`);
  const startEl = el(`schedStart-${masterId}`);
  const endEl = el(`schedEnd-${masterId}`);
  const noteEl = el(`schedNote-${masterId}`);
  if (saveBtn.dataset.wired) return;
  saveBtn.dataset.wired = '1';

  dateFromEl.value = todayStr();

  async function loadCurrent() {
    const date = dateFromEl.value || todayStr();
    currentEl.innerHTML = '<span class="note">загружаю…</span>';
    try {
      const shifts = await fetchJson(`/schedule?masterId=${masterId}&date=${date}`);
      const shift = shifts.find((s) => s.date === date);
      const isFullDayOff = shift?.breaks?.some((b) => b.startTime <= '10:00' && b.endTime >= '20:00');
      if (!shift || !shift.breaks?.length) {
        currentEl.innerHTML = '<span class="note">На эту дату перерывов/выходного не задано (стандартные часы 10:00-20:00)</span>';
      } else if (isFullDayOff) {
        currentEl.innerHTML = '<div class="break-row"><span class="note" style="flex:1">Выходной весь день</span><button class="remove-x" type="button" aria-label="Убрать" data-clear-date="' + date + '">✕</button></div>';
      } else {
        currentEl.innerHTML = shift.breaks
          .map((b) => `<div class="break-row"><span class="note" style="flex:1">Перерыв ${b.startTime}–${b.endTime}</span><button class="remove-x" type="button" aria-label="Убрать" data-clear-date="${date}">✕</button></div>`)
          .join('');
      }
      currentEl.querySelectorAll('[data-clear-date]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await fetch(`${API}/schedule`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
              body: JSON.stringify({ masterId, date: btn.dataset.clearDate, startTime: '10:00', endTime: '20:00', breaks: [] }),
            });
            loadCurrent();
          } catch (err) {
            if (noteEl) noteEl.textContent = `Не удалось убрать: ${err.message}`;
          }
        });
      });
    } catch (err) {
      currentEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    }
  }
  loadCurrent();
  dateFromEl.addEventListener('change', loadCurrent);

  const syncTimeFields = () => {
    if (timeFieldsEl) timeFieldsEl.style.display = dayOffEl?.checked ? 'none' : '';
  };
  syncTimeFields();
  dayOffEl?.addEventListener('change', syncTimeFields);

  saveBtn.addEventListener('click', async () => {
    const dateFrom = dateFromEl.value || todayStr();
    const dateTo = dateToEl?.value || dateFrom;
    if (dateTo < dateFrom) {
      if (noteEl) noteEl.textContent = 'Дата "по" раньше даты "с"';
      return;
    }
    const isDayOff = dayOffEl?.checked;
    const breakStart = isDayOff ? '10:00' : startEl?.value.trim();
    const breakEnd = isDayOff ? '20:00' : endEl?.value.trim();
    if (!isDayOff && (!breakStart || !breakEnd)) {
      if (noteEl) noteEl.textContent = 'Укажите время перерыва (с и до)';
      return;
    }
    saveBtn.disabled = true;
    const originalLabel = saveBtn.textContent;
    saveBtn.textContent = 'Сохраняю…';
    if (noteEl) noteEl.textContent = '';
    try {
      let totalConflicts = 0;
      for (let d = new Date(`${dateFrom}T00:00:00Z`); d.toISOString().slice(0, 10) <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        const res = await fetch(`${API}/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            masterId,
            date: dateStr,
            startTime: '10:00',
            endTime: '20:00',
            breaks: [{ startTime: breakStart, endTime: breakEnd }],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        totalConflicts += data.conflicts || 0;
      }
      if (noteEl) {
        noteEl.textContent = totalConflicts
          ? `Сохранено. На это время уже есть ${totalConflicts} реальных записей - в колокольчике уведомлений появилось, с кем связаться`
          : 'Сохранено';
      }
      loadCurrent();
    } catch (err) {
      if (noteEl) noteEl.textContent = `Не удалось сохранить: ${err.message}`;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  });
}

// Задача Влада (01.08.2026): "Клиент без предварительной записи" была рисунком -
// кнопка ничего не сохраняла, список услуг был одинаковый для любого мастера, поле
// "мастер" - обычный текст, который нужно было вписывать руками. Реальная версия:
// мастер известен заранее (своя страница мастера - он сам; у владельца/админа -
// кнопка "+" в шапке колонки нужного мастера в расписании), список услуг - только
// те, что реально есть у ЭТОГО мастера в master-services (у мастеров разный прайс,
// см. миграцию 004), можно отметить несколько (Окно 11 - тот же контракт serviceIds,
// что и на публичном сайте). Сохранение - тот же POST /bookings, что использует
// сайт, статус сразу "пришёл" (PATCH /bookings/:id/status) - клиент физически уже
// в кресле, ждать подтверждения не у кого.
function wireWalkIn(staff, services, masterServices) {
  const form = el('walkinForm');
  const picker = el('wfServicePicker');
  const summary = el('wfSummary');
  const submitBtn = el('wfSubmit');
  const cancelBtn = el('wfCancel');
  const resultEl = el('wfResult');
  const nameLabel = el('wfMasterName');
  const clientNameEl = el('wfClientName');
  const clientPhoneEl = el('wfClientPhone');
  if (!form || !picker || !summary || !submitBtn || !cancelBtn || !resultEl || !nameLabel || !clientNameEl || !clientPhoneEl) {
    return; // страница без этого блока (или он ещё не дошёл до нужной страницы)
  }

  // Блок В (ТЗ-готовность-к-продакшену, 01.08.2026) - "Добавить продажу", POST /sales
  // уже готов и рабочий на бэкенде (owner/admin-only), просто не вызывался ни разу с
  // фронта. Единственное место с РЕАЛЬНЫМ booking id прямо сейчас - только что
  // созданная walk-in запись (см. ниже): статичный календарь ещё не подключён к
  // реальным данным (Блок В, "Календарь записей" - отдельная крупная задача), поэтому
  // продажу через клик по примерной карточке в календаре пока не привязать честно.
  // Элементов нет на crm-master.html (мастер не имеет доступа к /sales на сервере,
  // requireRole ['owner','admin']) - тогда всё ниже no-op.
  const saleForm = el('wfSaleForm');
  const saleItemEl = el('wfSaleItem');
  const saleAmountEl = el('wfSaleAmount');
  const saleSubmitBtn = el('wfSaleSubmit');
  const saleResultEl = el('wfSaleResult');
  const hasSaleForm = saleForm && saleItemEl && saleAmountEl && saleSubmitBtn && saleResultEl;

  let currentMasterId = null;
  const selected = new Set();

  const servicesFor = (masterId) =>
    masterServices
      .filter((r) => r.masterId === masterId)
      .map((r) => ({ ...r, name: services.find((s) => s.id === r.serviceId)?.name ?? r.serviceId }));

  function renderSummary() {
    const rows = servicesFor(currentMasterId).filter((r) => selected.has(r.serviceId));
    if (rows.length === 0) {
      summary.textContent = 'Выберите хотя бы одну услугу';
      submitBtn.disabled = true;
      return;
    }
    const totalMin = rows.reduce((s, r) => s + r.durationMin, 0);
    const totalPrice = rows.reduce((s, r) => s + r.price, 0);
    summary.textContent = `Выбрано услуг: ${rows.length} · итого ${totalMin} мин · ${formatMoney(totalPrice)}`;
    submitBtn.disabled = false;
  }

  function renderPicker(masterId) {
    picker.innerHTML = '';
    selected.clear();
    const rows = servicesFor(masterId);
    if (rows.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'section-hint';
      hint.textContent = 'У этого мастера пока не назначено ни одной услуги в прайсе';
      picker.appendChild(hint);
    }
    for (const row of rows) {
      const label = document.createElement('label');
      label.className = 'service-check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = row.serviceId;
      const span = document.createElement('span');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sc-name';
      nameSpan.textContent = row.name;
      const meta = document.createElement('span');
      meta.className = 'sc-meta';
      const priceSpan = document.createElement('span');
      priceSpan.className = 'sc-price';
      priceSpan.textContent = formatMoney(row.price);
      const dot = document.createElement('span');
      dot.className = 'sc-dot';
      dot.textContent = '·';
      const durationSpan = document.createElement('span');
      durationSpan.className = 'sc-duration';
      durationSpan.textContent = `${row.durationMin} мин`;
      meta.append(priceSpan, dot, durationSpan);
      span.append(nameSpan, meta);
      label.append(input, span);
      input.addEventListener('change', () => {
        if (input.checked) selected.add(row.serviceId);
        else selected.delete(row.serviceId);
        renderSummary();
      });
      picker.appendChild(label);
    }
    renderSummary();
  }

  function openForWalkin(masterId, masterName) {
    currentMasterId = masterId;
    nameLabel.textContent = masterName;
    clientNameEl.value = '';
    clientPhoneEl.value = '';
    resultEl.hidden = true;
    if (hasSaleForm) {
      saleForm.hidden = true;
      delete saleForm.dataset.bookingId;
      saleItemEl.value = '';
      saleAmountEl.value = '';
      saleResultEl.hidden = true;
    }
    renderPicker(masterId);
    form.hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.querySelectorAll('.walkin-add-btn').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => openForWalkin(btn.dataset.masterId, btn.dataset.masterName));
  });

  // crm-master.html: единственный мастер - он и есть залогиненный сотрудник, выбирать не из чего
  const soloBtn = el('walkinSoloTrigger');
  if (soloBtn && !soloBtn.dataset.wired) {
    soloBtn.dataset.wired = '1';
    soloBtn.addEventListener('click', () => openForWalkin(staff.id, staff.name));
  }

  if (!cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', () => {
      form.hidden = true;
    });
  }

  if (!submitBtn.dataset.wired) {
    submitBtn.dataset.wired = '1';
    submitBtn.addEventListener('click', async () => {
      if (selected.size === 0 || !currentMasterId) return;
      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Сохраняю…';
      try {
        const now = new Date();
        const rounded = new Date(Math.ceil(now.getTime() / (5 * 60000)) * 5 * 60000);
        const startTime = `${pad2(rounded.getHours())}:${pad2(rounded.getMinutes())}`;
        const res = await fetch(`${API}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({
            masterId: currentMasterId,
            serviceIds: [...selected],
            date: todayStr(),
            startTime,
            clientName: clientNameEl.value.trim() || null,
            clientPhone: clientPhoneEl.value.trim() || null,
            channel: 'admin',
          }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          throw new Error(data.reason === 'overlap' ? 'у мастера уже занято это время' : data.error || `HTTP ${res.status}`);
        }
        await fetch(`${API}/bookings/${encodeURIComponent(data.booking.id)}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ status: 'done' }),
        });
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--ok';
        resultEl.textContent = `Готово: ${nameLabel.textContent}, ${startTime}, ${data.booking.totalDurationMin} мин, ${formatMoney(data.booking.totalPrice)}`;
        if (hasSaleForm) {
          saleForm.dataset.bookingId = data.booking.id;
          saleForm.hidden = false;
        }
        renderLiveProof(staff);
      } catch (err) {
        resultEl.hidden = false;
        resultEl.className = 'wf-result wf-result--err';
        resultEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        submitBtn.disabled = selected.size === 0;
        submitBtn.textContent = originalLabel;
      }
    });
  }

  if (hasSaleForm && !saleSubmitBtn.dataset.wired) {
    saleSubmitBtn.dataset.wired = '1';
    saleSubmitBtn.addEventListener('click', async () => {
      const bookingId = saleForm.dataset.bookingId;
      const itemName = saleItemEl.value.trim();
      const amount = Number(saleAmountEl.value);
      if (!bookingId || !itemName || !Number.isFinite(amount) || amount <= 0) {
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--err';
        saleResultEl.textContent = 'Укажите название товара и сумму больше нуля';
        return;
      }
      const originalLabel = saleSubmitBtn.textContent;
      saleSubmitBtn.disabled = true;
      saleSubmitBtn.textContent = 'Сохраняю…';
      try {
        const res = await fetch(`${API}/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ bookingId, itemName, amount }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--ok';
        saleResultEl.textContent = `Продажа добавлена: ${itemName}, ${formatMoney(amount)}`;
        saleItemEl.value = '';
        saleAmountEl.value = '';
      } catch (err) {
        saleResultEl.hidden = false;
        saleResultEl.className = 'wf-result wf-result--err';
        saleResultEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        saleSubmitBtn.disabled = false;
        saleSubmitBtn.textContent = originalLabel;
      }
    });
  }
}

// Задача Б.1 (ТЗ-готовность-к-продакшену, 01.08.2026): crm-master.html хардкодил
// "Алиовсад" в location-badge / шапке колонки календаря / скрытом bk-master / тексте
// комиссии - ломалось для Мамедхана и Екатерины, если они реально зайдут в свой
// кабинет. Элементов может не быть на странице (crm-owner.html/crm-admin.html) -
// функция тогда no-op, тот же паттерн, что у wirePortfolioEditors выше. Клик по
// конкретной appt-карточке в календаре ниже всё ещё статичный макет (openBooking
// в mockup-crm.js читает data-master из HTML) - календарь целиком не подключён к
// реальным данным (отдельная крупная задача, см. ТЗ-готовность-к-продакшену, Блок В),
// эта функция чинит только то, что видно ДО открытия любой записи.
function wireMasterSelfView(staff, pctOf) {
  const badge = el('selfNameBadge');
  if (badge) badge.textContent = staff.name;

  const avatarEl = el('selfAvatar');
  if (avatarEl) avatarEl.textContent = staff.name.split(' ').map((p) => p[0]).join('').toUpperCase();

  const nameHeadEl = el('selfNameHead');
  if (nameHeadEl) nameHeadEl.textContent = `${staff.name} (вы)`;

  const bkMaster = el('bk-master');
  if (bkMaster) bkMaster.value = staff.name;

  // На crm-master.html весь календарь - это ТОЛЬКО записи залогиненного (у мастера
  // нет вкладок с другими сотрудниками) - все appt-карточки в статичном примере были
  // написаны под "Алиовсад" буквально. Подменяем data-master на реальное имя, иначе
  // клик по любой карточке (openBooking → updateCommission в mockup-crm.js) снова
  // покажет "Алиовсад - владелец" Мамедхану или Екатерине. Не затрагивает
  // crm-owner.html/crm-admin.html - там несколько мастеров в одном календаре по
  // назначению, .appt[data-master] там обязаны остаться разными.
  if (el('walkinSoloTrigger')) {
    document.querySelectorAll('.appt[data-master]').forEach((node) => {
      node.dataset.master = staff.name;
    });
  }

  const noteEl = el('bk-commission-note');
  if (noteEl) {
    if (staff.role === 'owner') {
      noteEl.textContent = `${staff.name} - владелец, комиссию самому себе не платит, вся сумма услуги и так остаётся в бизнесе`;
    } else {
      const pct = pctOf(staff.id);
      noteEl.textContent = `${pct}% от суммы услуги (ваша ставка, разд.17.3) - показано для примера-записи выше, у реальной записи сумма своя`;
    }
  }
}

// Задача 2 (Окно 14, 02.08.2026) - вкладка "Личные данные" на crm-master.html:
// своя карточка сотрудника (портфолио редактируемо, услуги/ставка/график - только
// чтение, роль вообще не показываем). Элементов нет на crm-owner.html/crm-admin.html
// - тогда no-op.
function wireMasterSelfDataTab(staff, services, masterServices, pctOf) {
  const picker = el('selfServicePicker');
  if (!picker) return;

  const avatarEl = el('selfCardAvatar');
  if (avatarEl) avatarEl.textContent = staff.name.split(' ').map((p) => p[0]).join('').toUpperCase();
  const nameEl = el('selfCardName');
  if (nameEl) nameEl.textContent = staff.name;

  // Портфолио - переиспользуем wirePortfolioEditors как есть: переносим id-суффикс
  // "-self" на реальный staff.id, чтобы el(`portfolioExperience-${masterId}`) внутри
  // неё нашла именно эти поля.
  const saveBtn = el('selfPortfolioSaveBtn');
  if (saveBtn && saveBtn.dataset.masterId === 'self') {
    saveBtn.dataset.masterId = staff.id;
    ['portfolioExperience', 'portfolioStrengths', 'portfolioCertificates', 'portfolioBeforeAfter', 'portfolioNote'].forEach((prefix) => {
      const node = document.getElementById(`${prefix}-self`);
      if (node) node.id = `${prefix}-${staff.id}`;
    });
  }

  // Услуги - read-only список всех 8, отмечены те, что реально есть у ЭТОГО мастера
  // в master_services (назначает владелец в своей карточке "Сотрудники").
  const mine = new Map(masterServices.filter((r) => r.masterId === staff.id).map((r) => [r.serviceId, r]));
  picker.innerHTML = services
    .map((s) => {
      const row = mine.get(s.id);
      const checked = row ? 'checked' : '';
      const price = row ? `${row.price}₽` : s.priceLabel;
      const duration = row ? row.durationMin : s.durationMin;
      return `<label class="service-check"><input type="checkbox" ${checked} disabled><span><span class="sc-name">${s.name}</span><span class="sc-meta"><span class="sc-price">${price}</span><span class="sc-dot">·</span><span>${duration} мин</span></span></span></label>`;
    })
    .join('');

  // Ставка ЗП - владелец её не платит себе, у остальных - реальный % из
  // master_payroll_settings (тот же источник, что renderLiveProof уже читает).
  const rateEl = el('selfRateInput');
  if (rateEl) {
    rateEl.value = staff.role === 'owner' ? 'Не начисляется - вы владелец' : `${pctOf(staff.id)}%`;
  }

  wireScheduleSelfView(staff);
  wireScheduleRequestForm(staff);
}

// График - только просмотр, читает уже рабочий GET /schedule?masterId= (сервер сам
// сужает до своего мастера для роли master, server.mjs:714-732).
async function wireScheduleSelfView(staff) {
  const list = el('selfScheduleBreaks');
  const note = el('selfScheduleNote');
  if (!list || !note) return;
  try {
    const today = todayStr();
    const shifts = await fetchJson(`/schedule?masterId=${staff.id}&date=${today}`);
    const todayShift = shifts.find((s) => s.date === today);
    if (!todayShift || !todayShift.breaks?.length) {
      list.innerHTML = '';
      note.textContent = 'Сегодня перерывов не назначено (стандартные часы 10:00-20:00)';
      return;
    }
    list.innerHTML = todayShift.breaks
      .map((b) => `<div class="break-row"><span class="note">Перерыв ${b.startTime}–${b.endTime}</span></div>`)
      .join('');
    note.textContent = '';
  } catch (err) {
    note.textContent = `Не удалось получить график: ${err.message}`;
  }
}

// Форма "Запросить перерыв/выходной" (Задача 3, Окно 14) - POST /schedule-requests,
// владелец подтверждает/отклоняет отдельно (PATCH .../decision), время реально
// блокируется от онлайн-записи только после подтверждения.
function wireScheduleRequestForm(staff) {
  const submitBtn = el('reqSubmitBtn');
  const typeEl = el('reqType');
  const fromEl = el('reqDateFrom');
  const toEl = el('reqDateTo');
  const startEl = el('reqStartTime');
  const endEl = el('reqEndTime');
  const commentEl = el('reqComment');
  const resultEl = el('reqResult');
  const timeFields = el('reqTimeFields');
  const historyEl = el('reqHistory');
  if (!submitBtn || !typeEl || !fromEl || !toEl || !startEl || !endEl || !commentEl || !resultEl || !historyEl) return;

  const syncTimeFields = () => {
    if (timeFields) timeFields.style.display = typeEl.value === 'day_off' ? 'none' : '';
  };
  syncTimeFields();
  typeEl.addEventListener('change', syncTimeFields);

  async function loadHistory() {
    try {
      const rows = await fetchJson(`/schedule-requests?masterId=${staff.id}`);
      if (!rows.length) {
        historyEl.innerHTML = '<span class="note">Запросов пока нет</span>';
        return;
      }
      const statusLabel = { pending: 'На рассмотрении', approved: 'Одобрено', rejected: 'Отклонено' };
      historyEl.innerHTML = rows
        .map((r) => {
          const period = r.requestType === 'day_off' ? `${r.dateFrom}–${r.dateTo} (выходной)` : `${r.dateFrom} ${r.startTime}–${r.endTime}`;
          return `<div class="break-row"><span class="note">${period} · ${statusLabel[r.status] ?? r.status}${r.ownerComment ? ' · ' + r.ownerComment : ''}</span></div>`;
        })
        .join('');
    } catch (err) {
      historyEl.innerHTML = `<span class="note">Не удалось загрузить: ${err.message}</span>`;
    }
  }
  loadHistory();

  if (submitBtn.dataset.wired) return;
  submitBtn.dataset.wired = '1';
  submitBtn.addEventListener('click', async () => {
    const requestType = typeEl.value;
    const dateFrom = fromEl.value;
    const dateTo = toEl.value || dateFrom;
    if (!dateFrom) {
      resultEl.textContent = 'Укажите дату';
      return;
    }
    if (requestType === 'break' && (!startEl.value || !endEl.value)) {
      resultEl.textContent = 'Укажите время перерыва (с и до)';
      return;
    }
    try {
      const res = await fetch(`${API}/schedule-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({
          requestType,
          dateFrom,
          dateTo,
          startTime: requestType === 'break' ? startEl.value : null,
          endTime: requestType === 'break' ? endEl.value : null,
          masterComment: commentEl.value.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(`schedule-requests → ${res.status}`);
      resultEl.textContent = 'Запрос отправлен, владелец увидит уведомление';
      commentEl.value = '';
      loadHistory();
    } catch (err) {
      resultEl.textContent = `Не удалось отправить: ${err.message}`;
    }
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function dateToStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// "С начала периода по сегодня", не скользящее окно - Неделя с понедельника текущей
// недели, Месяц с 1 числа, Квартал с 1 числа текущего квартала, Год с 1 января. Тот
// же принцип, что и у "День" (= сегодняшний календарный день, не последние 24ч).
function periodStartStr(period) {
  const d = new Date();
  if (period === 'week') {
    const dow = (d.getDay() + 6) % 7; // 0 = понедельник
    d.setDate(d.getDate() - dow);
  } else if (period === 'month') {
    d.setDate(1);
  } else if (period === 'quarter') {
    d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1);
  } else if (period === 'year') {
    d.setMonth(0, 1);
  }
  return dateToStr(d);
}

// Владелец: вкладка "Выручка" - Неделя/Месяц/Квартал/Год (правка 28.07.2026). Один
// запрос на весь год вместо отдельного на каждый день - дальше бакетируем на
// фронте. priceOf/pctOf - те же функции по мастеру, что и в renderLiveProof (Окно 10).
// Разбивка по точкам убрана (Окно 13, 01.08.2026) - у Алихана одна точка, не две
// (уточнено самим Алиханом 01.08.2026), инфраструктура location_id в базе остаётся
// нетронутой на будущее (франшиза по городам, см. ТЗ-разработчику-корректировка).
async function renderRevenuePeriods(priceOf, pctOf, ownerIds) {
  if (!el('rvAllWeekRevenue')) return; // элементов нет вне страницы владельца

  const today = todayStr();
  let bookings;
  try {
    const res = await fetchJson(`/bookings?from=${periodStartStr('year')}&to=${today}`);
    bookings = res.bookings || [];
  } catch {
    return; // "считаю…" останется как есть - основная ошибка уже показана в панели выше
  }

  const fill = (prefix, rows) => {
    const revenueEl = el(`${prefix}Revenue`);
    const payrollEl = el(`${prefix}Payroll`);
    const netEl = el(`${prefix}Net`);
    if (!revenueEl && !payrollEl && !netEl) return;
    const revenue = rows.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
    const payroll = rows
      .filter((b) => !ownerIds.has(b.masterId))
      .reduce((sum, b) => sum + (bookingPrice(b, priceOf) * pctOf(b.masterId)) / 100, 0);
    if (revenueEl) revenueEl.innerHTML = `${formatMoney(revenue)} <span class="unsure">реально</span>`;
    if (payrollEl) payrollEl.innerHTML = `${formatMoney(payroll)} <span class="unsure">реально</span>`;
    if (netEl) netEl.innerHTML = `${formatMoney(revenue - payroll)} <span class="unsure">реально</span>`;
  };

  for (const [label, key] of [['Week', 'week'], ['Month', 'month'], ['Quarter', 'quarter'], ['Year', 'year']]) {
    const start = periodStartStr(key);
    const rows = bookings.filter((b) => b.date >= start && b.date <= today);
    fill(`rvAll${label}`, rows);
  }
}

// Блок В (ТЗ-готовность-к-продакшену, 01.08.2026) - "ЗП по неделе/месяцу/периоду в
// карточках сотрудников" (не своя, у владельца/админа) была "000 ₽ пример" нерабочим
// текстом, даже с реально выбранными датами сумма не считалась. Та же логика уже
// работает во "Выручке" (renderRevenuePeriods выше) и в "Моей зарплате" мастера
// (myWeekEl/myMonthEl в renderLiveProof) - здесь тот же принцип bookingPrice+pctOf,
// но по каждой карточке сотрудника отдельно. Свой отдельный fetch годовых броней (не
// переиспользует renderRevenuePeriods) - та функция рано выходит на crm-admin.html
// (там нет вкладки "Выручка" вообще), а карточки сотрудников с ЗП есть и у owner, и у admin.
async function renderStaffPayrollPeriods(priceOf, pctOf, ownerIds) {
  const masterIds = ['master-1', 'master-2', 'master-3'];
  const hasAnyTarget = masterIds.some((id, idx) => el(`payrollMaster${idx + 1}Week`) || el(`payrollMaster${idx + 1}Month`));
  if (!hasAnyTarget) return;

  const today = todayStr();
  let bookings;
  try {
    const res = await fetchJson(`/bookings?from=${periodStartStr('year')}&to=${today}`);
    bookings = res.bookings || [];
  } catch {
    return; // "считаю…" останется как было - основная ошибка уже показана в панели выше
  }

  const amountFor = (masterId, rows) => {
    if (ownerIds.has(masterId)) return null; // владелец комиссию себе не начисляет
    const revenue = rows.reduce((sum, b) => sum + bookingPrice(b, priceOf), 0);
    return (revenue * pctOf(masterId)) / 100;
  };
  const renderInto = (targetEl, masterId, rows) => {
    if (!targetEl) return;
    const amount = amountFor(masterId, rows);
    targetEl.innerHTML =
      amount === null
        ? `Не начисляется <span class="unsure">реально</span>`
        : `${formatMoney(amount)} <span class="unsure">реально</span>`;
  };

  masterIds.forEach((masterId, idx) => {
    const n = idx + 1;
    const weekEl = el(`payrollMaster${n}Week`);
    const monthEl = el(`payrollMaster${n}Month`);
    if (!weekEl && !monthEl) return;
    const rowsFor = (period) => {
      const start = periodStartStr(period);
      return bookings.filter((b) => b.masterId === masterId && b.date >= start && b.date <= today);
    };
    renderInto(weekEl, masterId, rowsFor('week'));
    renderInto(monthEl, masterId, rowsFor('month'));
  });

  // "Задать период" - раньше calcCustomPayroll (mockup-crm.js) только проверяла, что
  // обе даты выбраны, и оставляла "000 ₽ пример". Здесь - тот же реальный расчёт, но
  // по произвольному диапазону (data-master-id на кнопке, см. HTML). Не переопределяет
  // глобальную calcCustomPayroll - та отдельно осталась для личной "Моей зарплаты"
  // мастера (crm-master.html), где этот пункт не входил в скоуп Блока В.
  document.querySelectorAll('.payroll-period-picker button[data-master-id]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    const masterId = btn.dataset.masterId;
    btn.addEventListener('click', () => {
      const panel = btn.closest('.seg-panel');
      const dates = panel.querySelectorAll('input[type="date"]');
      const from = dates[0]?.value;
      const to = dates[1]?.value;
      const amountEl = panel.querySelector('.payroll-sum .amount');
      const noteEl = panel.querySelector('.payroll-note');
      if (!from || !to) {
        if (noteEl) noteEl.textContent = 'Укажите обе даты (с и по), чтобы задать период';
        return;
      }
      const rows = bookings.filter((b) => b.masterId === masterId && b.date >= from && b.date <= to);
      if (amountEl) {
        const amount = amountFor(masterId, rows);
        amountEl.innerHTML =
          amount === null ? `Не начисляется <span class="unsure">реально</span>` : `${formatMoney(amount)} <span class="unsure">реально</span>`;
      }
      if (noteEl) noteEl.textContent = `Период ${from}–${to}: посчитано по реальным броням за этот диапазон`;
    });
  });
}

export function initCrmAuth(requiredRole) {
  const gate = buildLoginGate();
  const main = el('crmMain');
  const sessionInfo = el('sessionInfo');
  const logoutBtn = el('logoutBtn');

  function reveal(staff) {
    gate.hidden = true;
    if (main) main.hidden = false;
    if (sessionInfo) sessionInfo.textContent = `${staff.name} · ${ROLE_LABELS[staff.role] ?? staff.role}`;
    if (logoutBtn) logoutBtn.hidden = false;
    // Влад 28.07.2026: у сотрудника в базе ровно одна роль (staff.role, без комбинирования) -
    // вкладки других ролей ведут в 404 или в чужой доступ, поэтому показываем только свою,
    // не весь переключатель. Раньше здесь были ссылки на все три роли всегда.
    document.querySelectorAll('#roleSwitch a[data-role]').forEach((a) => {
      a.hidden = a.dataset.role !== staff.role;
    });
    renderLiveProof(staff);
    wireNotifications(staff);
  }

  // Баг (найден Владом 02.08.2026): заход на crm-master.html с уже сохранённой в
  // браузере сессией владельца молча показывал владельца вместо формы входа -
  // "перекидывает в окно владельца" при попытке зайти в аккаунт мастера. Причина -
  // staff.role !== 'owner' ниже пропускал владельца мимо проверки роли страницы.
  // Различаем два случая: свежий логин (fromLogin=true, сразу после сабмита формы)
  // уводит на СВОЮ страницу по роли - это рабочий путь входа мастера/админа через
  // единственную публичную ссылку "Вход для сотрудников" (ведёт на crm-owner.html),
  // не трогаем. Восстановление СТАРОЙ сессии другой роли на чужой странице
  // (fromLogin не передан) больше не подставляет чужие данные и не молчит - чистит
  // сессию и показывает форму входа прямо на этой странице, чтобы можно было
  // сразу ввести данные нужной роли.
  function handleStaff(staff, fromLogin) {
    if (staff.role !== requiredRole) {
      if (fromLogin) {
        location.href = ROLE_PAGE[staff.role] || 'crm-owner.html';
      } else {
        clearSession();
        gate.hidden = false;
      }
      return;
    }
    reveal(staff);
  }

  el('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = el('loginEmail').value.trim();
    const pin = el('loginPin').value.trim();
    const errEl = el('loginError');
    errEl.hidden = true;
    try {
      const data = await apiLogin(email, pin);
      setSession(data.token, data.staff);
      handleStaff(data.staff, true);
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  logoutBtn?.addEventListener('click', () => {
    clearSession();
    location.reload();
  });

  if (main) main.hidden = true;
  const existing = getStoredStaff();
  if (existing && getToken()) {
    handleStaff(existing);
  } else {
    gate.hidden = false;
  }
}

// Реэкспорт для отладки в консоли из макета, если понадобится (не используется UI).
window.__crmAuthDebug = { getMasters, getServices };
