// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Self-view мастера (шапка "Вы: имя",
// подмена data-master в примерном календаре) + вкладка "Личные данные"
// (crm-master.html). Код перенесён 1в1, поведение не менялось.
import { el, formatMoney } from './crm-shared.js';
import { applyAvatar } from './crm-avatar.js';
import { renderWeeklySelfReadOnly } from './crm-schedule-editor.js';
import { wireScheduleRequestForm } from './crm-schedule-request-form.js';
import { sortByServiceOrder } from '../storage.js';

// Задача Б.1 (ТЗ-готовность-к-продакшену, 01.08.2026): crm-master.html хардкодил
// "Алиовсад" в location-badge / шапке колонки календаря / скрытом bk-master / тексте
// комиссии - ломалось для Мамедхана и Екатерины, если они реально зайдут в свой
// кабинет. Элементов может не быть на странице (crm-owner.html/crm-admin.html) -
// функция тогда no-op, тот же паттерн, что у wirePortfolioEditors (crm-staff-admin.js).
// Клик по конкретной appt-карточке в календаре ниже всё ещё статичный макет
// (openBooking в mockup-crm.js читает data-master из HTML) - календарь целиком не
// подключён к реальным данным (отдельная крупная задача, см.
// ТЗ-готовность-к-продакшену, Блок В), эта функция чинит только то, что видно ДО
// открытия любой записи.
export function wireMasterSelfView(staff) {
  const badge = el('selfNameBadge');
  if (badge) badge.textContent = staff.name;

  // Своё фото профиля мастер видит там же, где владелец видит его в «Дне» и
  // «Команде» - в кружке над колонкой (правка Влада 15.08.2026)
  applyAvatar(el('selfAvatar'), staff);

  const nameHeadEl = el('selfNameHead');
  if (nameHeadEl) nameHeadEl.textContent = `${staff.name} (вы)`;

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

  // Комиссия за запись переехала 13.08.2026 в общую форму записи (#wfCommission,
  // assets/crm-walkin.js renderCommission) вместе с переносом карточки мастера с
  // макета #bd-1 - см. spec 2026-08-13-master-booking-card.md. Здесь её больше нет:
  // раньше это была подпись под примером-записью, теперь цифра считается по РЕАЛЬНОМУ
  // составу услуг открытой записи и той же ставке pctOf.
}

// Задача 2 (Окно 14, 02.08.2026) - вкладка "Личные данные" на crm-master.html:
// своя карточка сотрудника (портфолио редактируемо, услуги/ставка/график - только
// чтение, роль вообще не показываем). Элементов нет на crm-owner.html/crm-admin.html
// - тогда no-op.
export function wireMasterSelfDataTab(staff, services, masterServices, pctOf) {
  const picker = el('selfServicePicker');
  if (!picker) return;

  applyAvatar(el('selfCardAvatar'), staff);
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
  // Единый порядок показа услуг (storage.js SERVICE_ORDER) - тот же, что видит
  // владелец в карточке этого мастера
  picker.innerHTML = sortByServiceOrder(services)
    .map((s) => {
      const row = mine.get(s.id);
      const checked = row ? 'checked' : '';
      // GET /services отдаёт цену полем `price` - поля `priceLabel` в ответе нет
      // никогда, и услуга, которую мастеру не назначили, показывала ему "undefined"
      // вместо цены из прайса (найдено живым прогоном 16.08.2026). Формат тот же,
      // что в редакторе услуг у владельца - formatMoney (crm-master-services.js).
      const price = formatMoney(row ? row.price : s.price);
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

  renderWeeklySelfReadOnly(staff);
  wireScheduleRequestForm(staff);
}
