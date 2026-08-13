// Единая маска телефона для полей ввода CRM (13.08.2026). До этого поле "Телефон"
// в карточке сотрудника было обычным текстовым инпутом: номер можно было вписать в
// любом виде ("89001234567", "8 900 12 34 567"), карточки команды выглядели пёстро,
// а плейсхолдеры в разметке уже обещали формат "+7 900 000-00-00" (crm-owner.html,
// crm-admin.html) - интерфейс обещал одно, поле принимало другое.
//
// Формат намеренно взят тот же, что уже стоит в статичной разметке CRM
// ("+7 900 000-00-01" в карточках-примерах, placeholder формы записи), а не
// скобочный "+7 (900) ..." - иначе в одном интерфейсе жили бы два вида номера.
// Публичный виджет записи (app.js) форматирует телефон клиента по-своему
// ("+7 900 000 00 00", без дефисов) - это отдельная форма для клиента, не CRM,
// сознательно не трогаем.
//
// Формат хранения не меняется: сервер и поиск клиента по номеру работают по
// последним 10 цифрам (normalizePhoneKey, api/routes/clients.js) - разделители
// на это не влияют.

export const PHONE_PLACEHOLDER = '+7 900 000-00-00';
const FULL_PHONE_DIGITS = 11; // 7 + 10 цифр номера

function digitsOf(value) {
  return String(value ?? '').replace(/\D/g, '');
}

// "89001234567" / "+7 900 1234567" / "9001234567" -> "+7 900 123-45-67".
// Пустая строка на входе (или строка без цифр) даёт пустую строку - поле не должно
// само подставлять "+7", пока человек ничего не ввёл.
export function formatPhone(raw) {
  let digits = digitsOf(raw);
  if (!digits) return '';
  if (digits[0] === '8') digits = `7${digits.slice(1)}`;
  if (digits[0] !== '7') digits = `7${digits}`;
  digits = digits.slice(0, FULL_PHONE_DIGITS);
  const rest = digits.slice(1);
  let out = '+7';
  if (rest.length) out += ` ${rest.slice(0, 3)}`;
  if (rest.length > 3) out += ` ${rest.slice(3, 6)}`;
  if (rest.length > 6) out += `-${rest.slice(6, 8)}`;
  if (rest.length > 8) out += `-${rest.slice(8, 10)}`;
  return out;
}

// Мягкий вариант для УЖЕ сохранённых значений: приводим к маске только то, что
// реально похоже на полный номер. Иначе первая же отрисовка карточки молча
// переписала бы нестандартную запись ("добавочный 12", "нет номера") в "+7 ..." -
// и человек сохранил бы этот подлог, не заметив.
export function formatStoredPhone(raw) {
  const digits = digitsOf(raw);
  if (digits.length < 10 || digits.length > FULL_PHONE_DIGITS) return String(raw ?? '');
  return formatPhone(raw);
}

// Позиция каретки после n-й цифры в отформатированной строке. Без этого каждый ввод
// в середине номера прыгал бы в конец строки (маска переписывает value целиком).
function caretAfterDigits(formatted, digitCount) {
  if (digitCount <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (/\d/.test(formatted[i])) {
      seen += 1;
      if (seen === digitCount) return i + 1;
    }
  }
  return formatted.length;
}

export function wirePhoneField(input) {
  if (!input || input.dataset.phoneMask) return;
  input.dataset.phoneMask = '1';
  input.type = 'tel';
  input.inputMode = 'tel';
  input.autocomplete = 'tel';
  if (!input.placeholder) input.placeholder = PHONE_PLACEHOLDER;
  input.value = formatStoredPhone(input.value);
  input.addEventListener('input', () => {
    const caret = input.selectionStart ?? input.value.length;
    // "+7" в начале - не цифра номера, поэтому считаем именно цифры слева от каретки:
    // после форматирования ставим её после того же по счёту знака.
    const digitsBeforeCaret = digitsOf(input.value.slice(0, caret)).length;
    const formatted = formatPhone(input.value);
    if (formatted === input.value) return;
    input.value = formatted;
    const position = caretAfterDigits(formatted, digitsBeforeCaret);
    try { input.setSelectionRange(position, position); } catch { /* поле могло потерять фокус */ }
  });
}

// Все телефонные поля внутри узла разом. Идемпотентно (dataset.phoneMask) - можно
// звать после каждой перерисовки списка команды, обработчики не копятся.
export function wirePhoneFields(root) {
  root?.querySelectorAll('input[name="phone"], input[data-phone-mask-target]')
    .forEach((input) => wirePhoneField(input));
}
