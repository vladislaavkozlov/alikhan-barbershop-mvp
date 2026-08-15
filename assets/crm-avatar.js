// Аватар сотрудника - один источник разметки для всех мест, где раньше стоял кружок
// с инициалами (правка Влада 15.08.2026: «когда Али загружает фото в профиль, оно
// должно отображаться в кружочке заглушки в "День" и "Команда"»).
//
// Фото живёт в staff_media (kind='avatar'), в GET /staff приезжает списком media с
// относительным url `/media/<ключ>`. Базу API приклеиваем через mediaUrl - фронтенд
// раздаётся с github.io, где такого файла нет, и без этого фото молча не загрузится
// (см. комментарий в storage.js).
import { mediaUrl } from '../storage.js';

// Ту же глобаль читает crm-notifications.js. Через crm-auth.js не идём осознанно:
// crm-calendar.js импортов не имеет вовсе, а crm-auth тянет за собой дашборд -
// получилось бы кольцо модулей ради одной строки адреса

const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Одно слово - две первые буквы («Алиовсад» → «АЛ»), два и больше - по первой букве
// от имени и фамилии. Так карточка команды выглядит ровно как до этой правки: там
// раньше стояло name.slice(0, 2), и односложные имена не должны схлопнуться в одну букву
export function initialsOfName(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

// Ссылка на фото профиля или null, если сотрудник его ещё не загрузил.
// Работает и со «свежим» составом (staff.media), и со старым полем photoUrl
export function avatarUrlOf(staff) {
  const fromMedia = (staff?.media ?? []).find((item) => item.kind === 'avatar')?.url;
  const raw = fromMedia ?? staff?.photoUrl ?? null;
  return raw ? mediaUrl(window.ALIKHAN_API_URL, raw) : null;
}

// Разметка кружка. Есть фото - показываем его, нет - прежние инициалы, размер и
// рамка те же (.avatar), поэтому ряды карточек и колонок не скачут по высоте.
// extraClass - для мест со своим модификатором (например 'lg').
export function avatarMarkup(staff, { extraClass = '', initials } = {}) {
  const cls = `avatar${extraClass ? ` ${extraClass}` : ''}`;
  const url = avatarUrlOf(staff);
  const label = initials ?? initialsOfName(staff?.name);
  if (!url) return `<div class="${cls}">${esc(label)}</div>`;
  // alt пустой: рядом всегда стоит имя сотрудника, дублировать его диктору незачем.
  // loading=lazy - в «Дне» и «Команде» таких кружков может быть много сразу
  return `<div class="${cls} avatar--photo"><img src="${esc(url)}" alt="" loading="lazy"></div>`;
}

// Живая подстановка фото в уже отрисованный кружок - для мест, где разметка пришла
// из статичного HTML, а не из шаблона (кабинет мастера)
export function applyAvatar(node, staff) {
  if (!node) return;
  const url = avatarUrlOf(staff);
  if (!url) {
    node.textContent = initialsOfName(staff?.name);
    node.classList.remove('avatar--photo');
    return;
  }
  node.classList.add('avatar--photo');
  node.innerHTML = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.loading = 'lazy';
  node.append(img);
}
