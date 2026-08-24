// Контекст арендатора на время одного запроса (Фаза 1 мультиарендности, 24.08.2026,
// plans/2026-08-24-multitenancy-etap-a.md).
//
// Зачем. В базе появляется признак «чей это» (Фаза 2) и замок на уровне самой базы
// (Фаза 3). Замку нужно знать, от чьего имени идёт текущий запрос, и узнать это он
// может только из настройки соединения `app.tenant_id`. Проносить арендатора через
// 222 места с SQL руками - ровно тот класс ошибки, что уже случился 13.08.2026 с
// ролями (забытый список ролей в четырёх роутах). Поэтому арендатор живёт не в
// аргументах функций, а в `AsyncLocalStorage` - штатном модуле Node, без внешних
// зависимостей (у API их нет и не появляется, кроме pg).
//
// Как это выглядит для роутов. Никак: они по-прежнему пишут `pool.query(...)`.
// Соединение текущего запроса им отдаёт прокси `pool` из db.js, который берёт его
// отсюда.
//
// Fail-closed. Обращение к базе вне контекста - не «сходить на общий пул», а ошибка.
// Иначе первый же забытый роут молча получил бы доступ ко всем арендаторам сразу.
import { AsyncLocalStorage } from 'node:async_hooks';

// Барбершоп Алихана - первый арендатор, его строки в базе уже существуют. До Фазы 4
// (арендатор по домену) все запросы работают от его имени, поведение прода не меняется.
export const DEFAULT_TENANT_ID = 1;

// Служебный контекст запуска миграций: схема меняется поверх всех арендаторов сразу,
// политика доступа (Фаза 3) это значение пропускает. Никакой запрос от браузера
// получить его не может - оно ставится только в runMigrations.
export const SYSTEM_TENANT = '*';

const storage = new AsyncLocalStorage();

export class TenantContextMissingError extends Error {
  constructor() {
    super('tenant_context_missing');
    this.name = 'TenantContextMissingError';
    this.code = 'TENANT_CONTEXT_MISSING';
  }
}

// Нормализует и проверяет арендатора: пустое значение - ошибка, а не «ну ладно».
export function normalizeTenantId(tenantId) {
  if (tenantId === null || tenantId === undefined || tenantId === '') {
    throw new Error('invalid_tenant_id');
  }
  const value = String(tenantId).trim();
  if (!value) throw new Error('invalid_tenant_id');
  if (value !== SYSTEM_TENANT && !/^\d+$/.test(value)) throw new Error('invalid_tenant_id');
  return value;
}

export function runWithStore(store, fn) {
  return storage.run(store, fn);
}

export function currentStore() {
  return storage.getStore() ?? null;
}

export function currentTenantId() {
  const store = storage.getStore();
  if (!store) throw new TenantContextMissingError();
  return store.tenantId;
}

export function hasTenantContext() {
  return storage.getStore() !== undefined;
}
