// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Редакторы карточки сотрудника
// (портфолио + роль), доступные владельцу в "Сотрудники" (crm-owner.html). Код
// перенесён 1в1, поведение не менялось.
import { el } from './crm-shared.js';
import { API, getToken } from './crm-auth.js';

// Задача 4 (Окно 13, 01.08.2026, разд.17.15 ТЗ) - портфолио мастера (стаж/сильные
// стороны/сертификаты/фото "до-после"), самредактируемые владельцем поля в карточке
// "Сотрудники" (crm-owner.html). Читает значения из уже загруженного /staff, пишет
// через PUT /staff/:id/portfolio (owner-only на сервере). Кнопок может не быть на
// странице (crm-admin.html/crm-master.html) - функция тогда no-op.
export function wirePortfolioEditors(staffList) {
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

// Окно 36 (06.08.2026) - "Роль" в карточке сотрудника была набором чекбоксов
// ("Роли комбинируются"), хотя staff.role в схеме - одно значение, ни один клик
// никуда не отправлялся (PRODUCT_AUDIT_REPORT.md, разд. "Владелец"). Роут
// PUT /staff/:id/role уже существовал с Окна 14 (owner-only) - просто не был
// вызван отсюда. Тот же паттерн, что wirePortfolioEditors выше: читает текущее
// значение из уже загруженного /staff один раз (dataset.filled), пишет на change.
//
// Правка Влада 07.08.2026 - нативный <select> заменён на .custom-select (тот же
// виджет, что уже используют "Закреплён за мастером"/время/дата -
// КОНВЕНЦИЯ-ВСПЛЫВАЮЩИЕ-ЭЛЕМЕНТЫ.md прежде явно разрешала обычный select для
// короткого списка из 2-3 опций, но премиум-редизайн Окна 41 требует единый
// стиль выпадашек). pickCustomSelectOption (assets/mockup-crm.js) уже шлёт
// 'customselect:change' с {detail.value} - слушаем его вместо нативного 'change'.
const ROLE_SUMMARY_LABEL = { owner: 'Владелец', admin: 'Администратор', master: 'Мастер' };

function setRoleSelectValue(wrap, value) {
  const trigger = wrap.querySelector('.custom-select-trigger');
  const options = wrap.querySelectorAll('.custom-select-option');
  options.forEach((o) => o.classList.toggle('selected', o.dataset.value === value));
  const matched = wrap.querySelector(`.custom-select-option[data-value="${value}"]`);
  if (trigger && matched) trigger.textContent = matched.textContent;
  wrap.dataset.value = value;
}

export function wireRoleEditors(staffList) {
  document.querySelectorAll('.role-select').forEach((wrap) => {
    const masterId = wrap.dataset.masterId;
    if (!wrap.dataset.filled) {
      const staff = staffList.find((s) => s.id === masterId);
      if (staff) setRoleSelectValue(wrap, staff.role);
      wrap.dataset.filled = '1';
    }

    if (wrap.dataset.wired) return;
    wrap.dataset.wired = '1';
    const noteEl = el(`roleNote-${masterId}`);
    const labelEl = el(`roleLabel-${masterId}`);
    wrap.dataset.lastValue = wrap.dataset.value;
    wrap.addEventListener('customselect:change', async (e) => {
      const prevValue = wrap.dataset.lastValue ?? e.detail.value;
      const nextValue = e.detail.value;
      const trigger = wrap.querySelector('.custom-select-trigger');
      if (trigger) trigger.disabled = true;
      try {
        const res = await fetch(`${API}/staff/${masterId}/role`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify({ role: nextValue }),
        });
        if (res.status === 409) {
          // Замок последнего владельца (api/routes/staff.js, isLastOwnerDemotion) -
          // единственный отказ этого роута, который владелец получает по делу, а не
          // из-за сбоя. Показываем причину человеческим языком: "→ 409" ничего не
          // объясняет тому, кто просто выбрал пункт в списке.
          throw new Error('в системе должен остаться хотя бы один владелец');
        }
        if (!res.ok) throw new Error(`staff/${masterId}/role → ${res.status}`);
        wrap.dataset.lastValue = nextValue;
        if (noteEl) noteEl.textContent = 'Сохранено';
        if (labelEl) labelEl.textContent = ROLE_SUMMARY_LABEL[nextValue] ?? nextValue;
      } catch (err) {
        setRoleSelectValue(wrap, prevValue);
        if (noteEl) noteEl.textContent = `Не удалось сохранить: ${err.message}`;
      } finally {
        if (trigger) trigger.disabled = false;
      }
    });
  });
}
