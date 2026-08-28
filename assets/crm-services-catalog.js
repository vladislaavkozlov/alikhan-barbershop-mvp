// Каталог услуг арендатора в кабинете владельца (Окно 75, 28.08.2026).
//
// Зачем. До сегодняшнего дня услуги существовали ровно в том виде, в каком их завела
// миграция при первой сборке системы для барбершопа. Второй арендатор - клиника
// Карины - оказался без единой процедуры и без способа её добавить: ни кнопки, ни
// запроса. Этот раздел закрывает дыру со стороны человека, роуты - со стороны сервера
// (api/routes/services.js).
//
// Словарь вертикали работает и здесь: у барбершопа раздел называется «Услуги», у
// клиники - «Процедуры», и то же слово стоит в кнопках и подтверждениях. Название
// приходит с сервера, в разметке его нет.
import { fetchJson, apiSend } from './crm-auth.js';
import { T, Tc } from './crm-terms.js';
import { showError, describeError } from './crm-toast.js';

const money = (value) => `${Number(value || 0).toLocaleString('ru-RU')} руб.`;

// Пустой каталог - нормальное состояние нового арендатора, а не ошибка. Поэтому текст
// не «ничего не найдено», а прямая инструкция, что сделать
function emptyHtml() {
  return `<p class="crm-empty">${Tc('service.nomPl')} ещё не заведены. Нажмите «Добавить», чтобы создать первую -
  без этого ${T('client.nomPl')} не смогут записаться, а расписание останется пустым</p>`;
}

function cardHtml(service) {
  return `
    <details class="staff-card" data-service-id="${service.id}">
      <summary>
        <span class="staff-card__name">${escapeHtml(service.name)}</span>
        <span class="staff-card__meta">${service.durationMin} мин · ${money(service.price)}</span>
      </summary>
      <div class="staff-card__body">
        <div class="field">
          <label>Название</label>
          <input type="text" data-field="name" value="${escapeHtml(service.name)}" maxlength="120">
        </div>
        <div class="field">
          <label>Длительность, минут</label>
          <input type="number" data-field="durationMin" value="${service.durationMin}" min="5" step="5">
        </div>
        <div class="field">
          <label>Цена, рублей</label>
          <input type="number" data-field="price" value="${service.price}" min="0" step="50">
        </div>
        <div class="staff-card__actions">
          <button type="button" class="btn-primary" data-action="save">Сохранить</button>
          <button type="button" class="btn-ghost" data-action="delete">Удалить</button>
        </div>
      </div>
    </details>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// Любой отказ сервера показывается словами, а не кодом: словарь переводов живёт в
// crm-toast.js и покрыт тестом «каждый код ошибки переведён на человеческий язык»
async function send(path, method, body) {
  const res = await apiSend(path, method, body);
  if (!res.ok) {
    showError(describeError({ status: res.status, data: res.data }) ?? 'Не удалось сохранить');
    return false;
  }
  return true;
}

let services = [];

export async function renderServicesCatalog() {
  const list = document.getElementById('servicesList');
  if (!list) return;
  try {
    services = await fetchJson('/services');
  } catch {
    list.innerHTML = `<p class="crm-empty">Не удалось загрузить ${T('service.accPl')}. Обновите страницу</p>`;
    return;
  }
  list.innerHTML = services.length ? services.map(cardHtml).join('') : emptyHtml();
  const title = document.getElementById('servicesSectionTitle');
  if (title) title.textContent = Tc('service.nomPl');
  const addBtn = document.getElementById('serviceAddBtn');
  if (addBtn) addBtn.textContent = `Добавить ${T('service.acc')}`;
}

function readCard(card) {
  const value = (field) => card.querySelector(`[data-field="${field}"]`)?.value;
  const name = String(value('name') ?? '').trim();
  const durationMin = Number.parseInt(value('durationMin'), 10);
  const price = Number.parseInt(value('price'), 10);
  return { name, durationMin, price };
}

export function wireServicesCatalog() {
  const list = document.getElementById('servicesList');
  const addBtn = document.getElementById('serviceAddBtn');
  if (!list || !addBtn) return;

  addBtn.addEventListener('click', async () => {
    // Новая услуга рождается с понятным черновиком, а не с пустой формой: человеку
    // проще исправить название, чем заполнить четыре поля с нуля
    const draft = { name: `Новая ${T('service.nom')}`, durationMin: 30, price: 0 };
    if (!(await send('/services', 'POST', draft))) return;
    await renderServicesCatalog();
    // Новая карточка уходит в конец списка - раскрываем именно её, иначе человек
    // ищет, что же изменилось
    const cards = list.querySelectorAll('[data-service-id]');
    const fresh = cards[cards.length - 1];
    if (fresh) {
      fresh.open = true;
      fresh.querySelector('[data-field="name"]')?.select();
    }
  });

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const card = button.closest('[data-service-id]');
    const id = card?.dataset.serviceId;
    if (!id) return;

    if (button.dataset.action === 'save') {
      const body = readCard(card);
      if (!body.name) return showError(`Название - обязательное поле`);
      if (!Number.isInteger(body.durationMin) || body.durationMin <= 0) return showError('Длительность - целое число минут больше нуля');
      if (!Number.isInteger(body.price) || body.price < 0) return showError('Цена - целое число рублей, ноль или больше');
      if (await send(`/services/${id}`, 'PUT', body)) await renderServicesCatalog();
      return;
    }

    if (button.dataset.action === 'delete') {
      const service = services.find((s) => s.id === id);
      // Подтверждение обязательно: удаление снимает услугу и со всех сотрудников
      if (!window.confirm(`Удалить «${service?.name ?? ''}»? ${Tc('service.nom')} исчезнет из записи клиентов и у всех сотрудников. Записи, которые уже прошли с этой ${T('service.ins')}, удалить не даст сама система`)) return;
      if (await send(`/services/${id}`, 'DELETE')) await renderServicesCatalog();
    }
  });
}
