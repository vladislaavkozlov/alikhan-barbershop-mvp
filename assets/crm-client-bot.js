// Блок «Напоминания в Telegram» в карточке клиента (Волна 1, 01.09.2026).
//
// Вынесен из crm-clients.js отдельным модулем сознательно: тот при импорте
// вешает обработчики на window, и проверить разметку тестом, не поднимая браузер,
// было бы нельзя. Здесь только чистая функция разметки и провод обработчиков.
import { T, Tc } from './crm-terms.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Дата привязки в карточке нужна коротко: «с 1 сентября», без времени
function formatLinkedDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return `${Number(d)} ${months[Number(m) - 1]}`;
}

// Приглашение клиента в бота (Волна 1, 01.09.2026).
//
// Кнопка показывается только когда у заведения есть подключённый бот: недоступное
// действие лучше не показывать вовсе, чем показывать с подписью, почему оно не
// работает. Человек, который уже в боте, видит состояние, а не предложение.
//
// Ссылка одноразовая и живёт сутки, поэтому она не показывается заранее - её
// выдаёт нажатие. Повторное нажатие обесценивает прежнюю ссылку: пересланная
// могла уйти не туда, и возможность её отозвать важнее удобства «одна навсегда».
export function botSectionMarkup(card) {
  const bot = card.bot ?? {};
  if (!bot.available) return '';
  const cardId = escapeHtml(card.id);
  if (bot.linkedAt && !bot.unsubscribedAt) {
    const when = formatLinkedDate(bot.linkedAt);
    return `<div class="client-bot" data-client-bot>
      <div class="client-bot-head">
        <span class="client-bot-label">Бот напоминаний</span>
        <span class="client-bot-value"><b>подключены</b> с ${escapeHtml(when)}</span>
      </div>
    </div>`;
  }
  const note = bot.unsubscribedAt
    ? `<div class="client-bot-note">${escapeHtml(Tc('client.nom'))} отписался - новая ссылка вернёт напоминания</div>`
    : '';
  return `<div class="client-bot" data-client-bot>
    <div class="client-bot-head">
      <span class="client-bot-label">Бот напоминаний</span>
      <button type="button" class="btn btn-ghost btn-sm" data-bot-invite="${cardId}">Пригласить в бота</button>
    </div>
    ${note}
    <div class="client-bot-link" data-bot-link hidden>
      <input type="text" readonly data-bot-link-value>
      <button type="button" class="btn btn-ghost btn-sm" data-bot-copy>Скопировать</button>
      <div class="client-bot-note">Ссылка одноразовая и действует сутки - отправьте её ${escapeHtml(T('client.dat'))}</div>
    </div>
  </div>`;
}

