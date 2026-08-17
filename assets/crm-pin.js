// Смена своего PIN сотрудником (16.08.2026).
//
// Дыра, которую это закрывает: роут PUT /auth/pin живёт в API с самого начала, а
// колонка must_change_pin ставится в true каждому, кого владелец заводит через
// «Добавить сотрудника» (POST /staff выдаёт временный PIN и печатает его на экране
// владельцу). При этом ни один кабинет смену PIN не показывал - человек навсегда
// оставался с паролем, который знает тот, кто его заводил, и который побывал на
// чужом экране. Флаг mustChangePin приходил в ответе входа и никем не читался.
//
// Модуль сам находит свою разметку (#pinNew/#pinRepeat/#pinSaveBtn) - на страницах,
// где её нет, он молча ничего не делает, тот же приём, что у crm-master-self.js.
import { apiSend } from './crm-auth.js';
import { el } from './crm-shared.js';
import { reportError, reportSuccess, showError } from './crm-toast.js';
import { setButtonBusy } from './crm-loading.js';

// Сервер принимает ровно шесть цифр (handlePinChange, api/routes/auth.js) - держим
// то же правило на экране, чтобы человек узнал об этом до отправки, а не из отказа
const PIN_LENGTH = 6;
const PIN_RE = new RegExp(`^\\d{${PIN_LENGTH}}$`);

function onlyDigits(input) {
  input.addEventListener('input', () => {
    const cleaned = input.value.replace(/\D/g, '').slice(0, PIN_LENGTH);
    if (cleaned !== input.value) input.value = cleaned;
  });
}

export function wirePinChange(staff) {
  const newEl = el('pinNew');
  const repeatEl = el('pinRepeat');
  const button = el('pinSaveBtn');
  const note = el('pinNote');
  if (!newEl || !repeatEl || !button) return;

  if (!button.dataset.wired) {
    button.dataset.wired = '1';
    onlyDigits(newEl);
    onlyDigits(repeatEl);

    button.addEventListener('click', async () => {
      const newPin = newEl.value.trim();
      const repeat = repeatEl.value.trim();
      if (!PIN_RE.test(newPin)) {
        const text = `Новый PIN - ровно ${PIN_LENGTH} цифр`;
        if (note) note.textContent = text;
        showError(text);
        newEl.focus();
        return;
      }
      if (newPin !== repeat) {
        const text = 'PIN и повтор не совпали';
        if (note) note.textContent = text;
        showError(text);
        repeatEl.focus();
        return;
      }
      setButtonBusy(button, true);
      const result = await apiSend('/auth/pin', 'PUT', { newPin });
      setButtonBusy(button, false);
      if (!result.ok) {
        reportError(note, result, 'Не удалось сменить PIN');
        return;
      }
      // Значения не оставляем в полях: экран сотрудника часто стоит в зале, и
      // введённый PIN не должен висеть на нём до перезагрузки страницы
      newEl.value = '';
      repeatEl.value = '';
      reportSuccess(note, 'PIN изменён. В следующий раз входите с новым');
      const banner = el('pinMustChange');
      if (banner) banner.hidden = true;
    });
  }

  // Временный PIN, выданный при заведении сотрудника: пока человек его не сменил,
  // подсказка висит прямо над полями и подсвечивает раздел в первый вход
  const banner = el('pinMustChange');
  if (banner) banner.hidden = !staff?.mustChangePin;
}

document.addEventListener('crm:authenticated', (event) => wirePinChange(event.detail));
