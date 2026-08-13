// Декомпозиция crm-auth.js (Этап 1, 07.08.2026, structural refactoring - см.
// plans/2026-08-07-crm-auth-decomposition.md). Редактор услуг/цен/длительности
// мастера в карточке "Сотрудники" (crm-owner.html), read-only для остальных
// ролей. Код перенесён 1в1, поведение не менялось.
import { formatMoney } from './crm-shared.js';
import { API, getToken } from './crm-auth.js';

// Правка 03.08.2026: карточка сотрудника "Сотрудники" (владелец/админ) держала
// чекбоксы услуг мастера и поле длительности как чистую декорацию - ни одного
// fetch, "включено"/"выключено" не переживало перезагрузку страницы, хотя
// master_services в базе уже поддерживала это с самого Окна 8 (см. отчёт сессии
// 03.08.2026). Контейнер должен быть <div class="service-picker" data-master-id="…">
// (пустой, без статичных чекбоксов - их рисует эта функция). Только владелец
// реально включает/выключает услугу и меняет длительность (`canEdit`) -
// администратор/просмотр видят то же самое read-only, тот же уровень доступа, что
// уже есть у wireMasterSelfDataTab для самого мастера.
// 13.08.2026 - гонка двух рендереров одних и тех же чекбоксов: renderTeam
// (crm-team.js) рисует их с учётом "принимает клиентов", а эта функция вызывается
// из renderLiveProof и перерисовывала их заново, зная только роль зрителя - и
// возвращала услуги снятого с приёма в редактируемое состояние. Кто отработал
// последним, тот и определял результат. Признак берём из карточки, в которой лежит
// контейнер (data-provides-services ставит renderTeam) - один источник правды на
// обоих путях, вместо второго набора данных здесь.
// Роль управляющего появилась позже этой функции, а она осталась с проверкой
// "только владелец" - под управляющим услуги были недоступны у ВСЕХ сотрудников,
// хотя карточка команды их разрешала, а PUT /master-services/:masterId/:serviceId
// на сервере открыт роли management (owner+manager). Живой repro Влада 13.08.2026:
// зашёл управляющим, галки на месте, а услуги не меняются.
export function wireMasterServiceEditors(staffRole, services, masterServices) {
  const canEdit = staffRole === 'owner' || staffRole === 'manager';
  document.querySelectorAll('.service-picker[data-master-id]').forEach((container) => {
    const offDuty = container.closest('[data-provides-services="0"]') != null;
    // Карточку защищённого владельца управляющий не редактирует - renderTeam помечает
    // её data-locked-owner, здесь читаем ту же метку, чтобы оба пути совпадали
    const lockedOwner = container.closest('[data-locked-owner]') != null;
    renderMasterServiceEditor(container, container.dataset.masterId, canEdit && !offDuty && !lockedOwner, services, masterServices);
  });
}

export function renderMasterServiceEditor(container, masterId, canEdit, services, masterServices) {
  container.innerHTML = '';
  container.classList.toggle('readonly', !canEdit);
  const assigned = new Map(masterServices.filter((r) => r.masterId === masterId).map((r) => [r.serviceId, r]));
  const note = document.createElement('p');
  note.className = 'section-hint';
  note.hidden = true;

  for (const service of services) {
    const row = assigned.get(service.id);
    const label = document.createElement('label');
    label.className = 'service-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(row);
    input.disabled = !canEdit;

    const span = document.createElement('span');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'sc-name';
    nameSpan.textContent = service.name;
    const meta = document.createElement('span');
    meta.className = 'sc-meta';
    const priceSpan = document.createElement('span');
    priceSpan.className = 'sc-price';
    priceSpan.textContent = formatMoney(row ? row.price : service.price);
    const dot = document.createElement('span');
    dot.className = 'sc-dot';
    dot.textContent = '·';
    const durationSpan = document.createElement('span');
    durationSpan.className = 'sc-duration';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '5';
    durationInput.step = '5';
    durationInput.className = 'sc-duration-input';
    durationInput.value = row ? row.durationMin : service.durationMin;
    durationInput.disabled = !canEdit || !row;
    durationInput.addEventListener('click', (e) => e.stopPropagation());
    const durationUnit = document.createElement('span');
    durationUnit.className = 'sc-duration-unit';
    durationUnit.textContent = 'мин';
    durationSpan.append(durationInput, durationUnit);
    meta.append(priceSpan, dot, durationSpan);
    span.append(nameSpan, meta);
    label.append(input, span);
    container.appendChild(label);

    if (!canEdit) continue;

    async function save(enabled) {
      const body = enabled ? { enabled: true, durationMin: Number(durationInput.value) || service.durationMin } : { enabled: false };
      try {
        const res = await fetch(`${API}/master-services/${encodeURIComponent(masterId)}/${encodeURIComponent(service.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`master-services → ${res.status}`);
        note.hidden = true;
      } catch (err) {
        input.checked = !enabled; // откат чекбокса, если сервер/сеть отказали
        durationInput.disabled = !canEdit || !input.checked;
        note.hidden = false;
        note.textContent = `Не удалось сохранить «${service.name}»: ${err.message}`;
      }
    }

    input.addEventListener('change', () => {
      durationInput.disabled = !input.checked;
      save(input.checked);
    });
    durationInput.addEventListener('change', () => {
      if (input.checked) save(true);
    });
  }
  container.appendChild(note);
}
