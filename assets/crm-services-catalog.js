// Каталог услуг арендатора в кабинете владельца (Окно 75, 28.08.2026).
//
// Зачем. До сегодняшнего дня услуги существовали ровно в том виде, в каком их завела
// миграция при первой сборке системы для барбершопа. Второй арендатор - клиника
// Карины - оказался без единой процедуры и без способа её добавить: ни кнопки, ни
// запроса. Этот раздел закрывает дыру со стороны человека, роуты - со стороны сервера
// (api/routes/services.js).
//
// Вёрстка НЕ изобретается заново (конвенция проекта): плитка каталога - тот же
// компонент .service-check в сетке .service-picker, что и «Услуги и время» в карточке
// сотрудника, с теми же инлайн-полями цены и длительности. Разница только по смыслу:
// там владелец раздаёт мастеру услуги из каталога, здесь - заводит сам каталог,
// поэтому вместо галки «делает / не делает» стоит кнопка удаления.
//
// Словарь вертикали работает и здесь: у барбершопа раздел называется «Услуги», у
// клиники - «Процедуры», и то же слово стоит в кнопках и подтверждениях.
import { fetchJson, apiSend } from './crm-auth.js';
import { T, Tc, P } from './crm-terms.js';
import { showError, showSuccess, describeError } from './crm-toast.js';

let services = [];

async function send(path, method, body) {
  const res = await apiSend(path, method, body);
  if (!res.ok) {
    showError(describeError({ status: res.status, data: res.data }) ?? 'Не удалось сохранить');
    return false;
  }
  return true;
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

// Пустой каталог - нормальное состояние нового арендатора, а не ошибка. Поэтому текст
// не «ничего не найдено», а прямая инструкция, что сделать
function emptyHtml() {
  return `<p class="crm-empty">${Tc('service.nomPl')} ещё не заведены. Нажмите «Добавить», чтобы создать первую -
  без этого ${T('client.nomPl')} не смогут записаться, а расписание останется пустым</p>`;
}

function tileHtml(service) {
  return `
    <div class="service-check service-check--catalog" data-service-id="${service.id}">
      <span>
        <input type="text" class="sc-name sc-name-input" value="${escapeHtml(service.name)}" maxlength="120"
               aria-label="Название: ${escapeHtml(service.name)}">
        <span class="sc-meta">
          <span class="sc-price">
            <input type="text" inputmode="numeric" class="sc-price-input" value="${service.price}"
                   aria-label="${escapeHtml(P('service.priceAria', { name: service.name }))}">
            <span class="sc-price-unit">₽</span>
          </span>
          <span class="sc-dot">·</span>
          <span class="sc-duration">
            <input type="number" min="5" step="5" class="sc-duration-input" value="${service.durationMin}"
                   aria-label="Длительность: ${escapeHtml(service.name)}">
            <span class="sc-duration-unit">мин</span>
          </span>
        </span>
      </span>
      <button type="button" class="sc-remove" data-action="delete"
              aria-label="Удалить: ${escapeHtml(service.name)}" title="Удалить">×</button>
    </div>`;
}

export async function renderServicesCatalog() {
  const list = document.getElementById('servicesList');
  if (!list) return;
  try {
    services = await fetchJson('/services');
  } catch {
    list.innerHTML = `<p class="crm-empty">Не удалось загрузить ${T('service.accPl')}. Обновите страницу</p>`;
    return;
  }
  list.className = services.length ? 'service-picker' : '';
  list.innerHTML = services.length ? services.map(tileHtml).join('') : emptyHtml();
  const addBtn = document.getElementById('serviceAddBtn');
  if (addBtn) addBtn.textContent = `Добавить ${T('service.acc')}`;
  setDirty(false);
}

// Правки копятся и уезжают одной кнопкой - тот же порядок, что в карточке сотрудника:
// человек правит несколько плиток подряд и сохраняет разом, а не ловит по тосту на
// каждое поле
function setDirty(value) {
  const save = document.getElementById('servicesSaveBtn');
  if (save) save.hidden = !value;
}

function readTile(tile) {
  const name = String(tile.querySelector('.sc-name-input')?.value ?? '').trim();
  const price = Number.parseInt(String(tile.querySelector('.sc-price-input')?.value ?? '').replace(/\s/g, ''), 10);
  const durationMin = Number.parseInt(tile.querySelector('.sc-duration-input')?.value, 10);
  return { name, price, durationMin };
}

function changedTiles(list) {
  const out = [];
  for (const tile of list.querySelectorAll('.service-check[data-service-id]')) {
    const id = tile.dataset.serviceId;
    const was = services.find((s) => s.id === id);
    const now = readTile(tile);
    if (!was) continue;
    if (was.name !== now.name || was.price !== now.price || was.durationMin !== now.durationMin) {
      out.push({ id, tile, ...now });
    }
  }
  return out;
}

export function wireServicesCatalog() {
  const list = document.getElementById('servicesList');
  const addBtn = document.getElementById('serviceAddBtn');
  const saveBtn = document.getElementById('servicesSaveBtn');
  if (!list || !addBtn) return;

  list.addEventListener('input', () => setDirty(changedTiles(list).length > 0));

  addBtn.addEventListener('click', async () => {
    // Новая услуга рождается понятным черновиком, а не пустой формой: исправить
    // название проще, чем заполнить три поля с нуля
    const draft = { name: `Новая ${T('service.nom')}`, durationMin: 30, price: 0 };
    if (!(await send('/services', 'POST', draft))) return;
    await renderServicesCatalog();
    const tiles = list.querySelectorAll('.service-check[data-service-id]');
    const fresh = tiles[tiles.length - 1];
    fresh?.querySelector('.sc-name-input')?.select();
  });

  saveBtn?.addEventListener('click', async () => {
    const changes = changedTiles(list);
    for (const change of changes) {
      if (!change.name) return showError('Название - обязательное поле');
      if (!Number.isInteger(change.durationMin) || change.durationMin <= 0) {
        return showError('Длительность - целое число минут больше нуля');
      }
      if (!Number.isInteger(change.price) || change.price < 0) {
        return showError('Цена - целое число рублей, ноль или больше');
      }
    }
    for (const change of changes) {
      const ok = await send(`/services/${change.id}`, 'PUT', {
        name: change.name, price: change.price, durationMin: change.durationMin,
      });
      if (!ok) return;
    }
    await renderServicesCatalog();
    if (changes.length) showSuccess('Сохранено');
  });

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="delete"]');
    if (!button) return;
    const tile = button.closest('[data-service-id]');
    const id = tile?.dataset.serviceId;
    if (!id) return;
    const service = services.find((s) => s.id === id);
    if (!window.confirm(`Удалить «${service?.name ?? ''}»? ${Tc('service.nom')} исчезнет из записи и у всех сотрудников. Если она уже стоит в чьих-то визитах, система удалить не даст`)) return;
    if (await send(`/services/${id}`, 'DELETE')) await renderServicesCatalog();
  });
}
