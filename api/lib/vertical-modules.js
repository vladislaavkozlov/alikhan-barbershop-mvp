// Флаги модулей по арендаторам (Этап B мультиарендности, Фаза 1, 24.08.2026,
// plans/2026-08-24-multitenancy-etap-b-slovar.md).
//
// Принцип тот же, что у ролей в permissions.js: один список, а не условие
// `if (vertical === 'clinic')`, размноженное по коду. Именно размноженный литерал
// стоил инцидента 13.08.2026, когда роль manager забыли в четырёх роутах.
//
// Состав флагов - решение Влада на гейте 24.08.2026, ровно два. Витрина мастеров и
// запись с улицы флагами не становятся: это его осознанный выбор, а не пропуск.
// Третий флаг, когда понадобится, добавляется одной строкой ниже плюс строкой в
// карте роутов - в кабинетах и обработчиках править нечего.
export const MODULE_KEYS = ['missedProfit', 'payroll'];

// Умолчания на вертикаль. У барбершопа включено всё - у Алихана не должно пропасть
// ничего. Клиника унаследует те же умолчания, а своё значение получит строкой в
// справочнике при подключении (следующее окно): выключать разделы Карине заранее,
// не спросив её, значило бы решать за клиента.
export const MODULE_DEFAULTS = {
  barbershop: { missedProfit: true, payroll: true },
  clinic: { missedProfit: true, payroll: true },
};

// Значение из справочника - это jsonb, то есть внутри может лежать что угодно.
// Молча включённый или выключенный по мусору раздел хуже, чем проигнорированный:
// берём только известные ключи и только настоящие true/false
export function normalizeTenantModules(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of MODULE_KEYS) {
    if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  return out;
}

// Что в итоге включено у арендатора: умолчание его вертикали плюс его собственное
// переопределение. Незнакомая вертикаль получает барбершопные умолчания - то же
// правило отката, что и у словаря
export function effectiveModules(vertical, tenantModules) {
  const defaults = MODULE_DEFAULTS[vertical] ?? MODULE_DEFAULTS.barbershop;
  return { ...defaults, ...normalizeTenantModules(tenantModules) };
}

export function isModuleEnabled(tenant, key) {
  return effectiveModules(tenant?.vertical, tenant?.modules)[key] === true;
}
