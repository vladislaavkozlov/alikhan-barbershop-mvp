# Декомпозиция assets/crm-auth.js — Этап 1 структурного рефакторинга

Контекст: структурный аудит проекта (эта же сессия) назвал `crm-auth.js` (1908 строк)
главной точкой связности - импортируется всеми тремя ролевыми страницами
(owner/admin/master), 90% содержимого не относится к auth. Задача - разнести по
доменам, поведение не менять (structural refactoring, код переносится, а не
переписывается).

## Правила (буквально из брифа Влада)
1. Поведение/дизайн/тексты/бизнес-логика/API-контракты не меняются.
2. Код переносится, не переписывается.
3. По одному домену за раз, отдельный коммит на каждый.
4. После каждого переноса - прогон проверок (node --check, офлайн-тесты, живой CDP).
5. Красная проверка → стоп, чиню только регрессию от переноса.
6. Не улучшать попутно.
7. Без новых архитектурных слоёв без необходимости.
8. Global/window-зависимости - делать явными где безопасно.
9. Уже маленькие файлы (crm-notifications/calendar/schedule-views/app-shell/clients/
   owner-today/schedule-requests) не трогать.

## Ключевое решение по последовательности

`initCrmAuth` (точка входа, её импортируют все 3 HTML-страницы) и настоящая
auth-логика (getToken/setSession/clearSession/apiLogin/buildLoginGate/fetchJson/
apiSend) **остаются в `crm-auth.js` до конца** - не переименовываю и не двигаю файл.
Вместо этого по одному домену вынимаю ВСЁ остальное. Так HTML-страницы (`import
{ initCrmAuth } from './assets/crm-auth.js'`) не трогаются вообще, а `crm-auth.js`
к концу естественно сжимается до реального auth-объёма. Меньше движущихся частей,
меньше риска.

Три файла уже импортируют `fetchJson`/`apiSend` напрямую из `crm-auth.js`
(`crm-clients.js`, `crm-schedule-requests.js`, `crm-owner-today.js`) - раз эти
функции остаются в `crm-auth.js`, их импорты тоже не трогаются.

`renderLiveProof` - не только "дашборд", а ЕЩЁ и оркестратор: делает один
`Promise.all` fetch (staff/services/bookings/masterServices/payrollRows) и на
результате вызывает fan-out всех остальных `wire*`/`render*` функций (строки
351-366 оригинала). Эти вызовы НЕЛЬЗЯ поднять выше (в `initCrmAuth`/`reveal()`) -
они используют локальные переменные из этого fetch (`staffList`, `priceOf`,
`pctOf`, `ownerIds`), а сам `renderLiveProof(staff)` в `reveal()` вызывается БЕЗ
await. Перенос этого хвоста в другое место изменил бы порядок/тайминг выполнения -
запрещено правилом 1. Поэтому `renderLiveProof` едет в свой файл `crm-dashboard.js`
ЦЕЛИКОМ (сам fetch + собственный рендер цифр + fan-out call-list в ТОМ ЖЕ порядке),
импортируя тела остальных доменов из их новых файлов. Это единственное место,
где новый файл легитимно импортирует много доменов - потому что он оркестратор,
а не бизнес-логика.

## Целевые файлы (10 новых + сильно уменьшенный crm-auth.js)

| # | Файл | Из crm-auth.js (домен) | Примерно строк |
|---|---|---|---|
| 0 | `assets/crm-shared.js` (NEW, инфраструктура) | `el`, `todayStr`, `formatMoney`, `bookingPrice`, `pad2` - чистые хелперы с 2+ потребителями в разных будущих доменах | ~40 |
| 1 | `assets/crm-widgets.js` | виджеты даты/времени (`renderDateSelect`/`renderTimeSelect`/...) | ~75 |
| 2 | `assets/crm-staff-admin.js` | портфолио + роль сотрудника | ~100 |
| 3 | `assets/crm-schedule-editor.js` | разовый редактор графика + недельный редактор + `renderWeeklySelfReadOnly` | ~400 |
| 4 | `assets/crm-walkin.js` | визард walk-in (`wireWalkIn`) | ~320 |
| 5 | `assets/crm-master-services.js` | цены/услуги мастера | ~95 |
| 6 | `assets/crm-schedule-request-form.js` | форма заявки на график (сторона мастера) | ~130 |
| 7 | `assets/crm-payroll.js` | периоды ЗП/выручки, "Задать период" | ~230 |
| 8 | `assets/crm-master-self.js` | self-view мастера + self-data-таб | ~90 |
| 9 | `assets/crm-booking-status.js` | радио статуса брони + `toggleNoShow` | ~95 |
| 10 | `assets/crm-dashboard.js` | `renderLiveProof` (оркестратор + цифры дашборда) | ~200 |

`crm-auth.js` после всех шагов: импорты, session-константы, `getToken/getStoredStaff/
setSession/clearSession`, `buildLoginGate`, `apiLogin`, `fetchJson`, `apiSend`,
`initCrmAuth`, `window.__crmAuthDebug` - ~180-220 строк.

## Порядок фаз (от изолированного к связанному)

1. `crm-shared.js` - создание, `crm-auth.js` начинает импортировать из него вместо
   локальных копий (сами функции остаются вызываться из тех же мест до их
   переноса в свои домены).
2. `crm-widgets.js`
3. `crm-staff-admin.js`
4. `crm-schedule-editor.js`
5. `crm-master-services.js`
6. `crm-schedule-request-form.js`
7. `crm-payroll.js`
8. `crm-master-self.js` (зависит от 4 и 6)
9. `crm-booking-status.js` (заодно: `updateNoShowUi()` → `window.updateNoShowUi()`,
   явная пометка глобальной зависимости от mockup-crm.js, без изменения поведения)
10. `crm-walkin.js` (зависит от 10 через `renderLiveProof` - переносится предпоследним)
11. `crm-dashboard.js` (оркестратор, зависит от всех - переносится последним)

После каждой фазы: `node --check` на все тронутые файлы, полный `node --test`,
живой CDP-прогон `tools/verify-refactor-crm-auth-decomposition.mjs` (пишется в
фазе 1, дополняется по ходу, каждый раз гоняется целиком).

## Пойманная регрессия (фаза 6, исправлена в том же коммите)

`periodStartStr` вызывается не только внутри перенесённых в `crm-payroll.js`
функций, но и напрямую в `renderLiveProof` (остаётся в `crm-auth.js` до фазы 10) -
блок "Моя зарплата" мастера (День/Неделя/Месяц). Перенос без экспорта сломал
`renderLiveProof` на crm-master.html (ReferenceError, пойман try/catch внутри
функции - тихо проглатывался в console.error, не бросал явную ошибку), из-за
чего всё, что вызывается ПОСЛЕ этого блока в той же функции (wireWalkIn,
wireMasterSelfView, wireMasterSelfDataTab), переставало отрабатывать. Живой
CDP-прогон поймал это сразу (4 упавших проверки на странице мастера), root cause
найден инъекцией console.error-перехватчика через
`Page.addScriptToEvaluateOnNewDocument`. Исправлено экспортом `periodStartStr`
из `crm-payroll.js` и обратным импортом в `crm-auth.js`. Урок для оставшихся
фаз: перед переносом грепать ВСЕ callsites функции по всему файлу, не только
её определение - иначе легко унести функцию, которую снаружи ещё используют.

## Известные скрытые зависимости (не чиним, документируем)

- Виджеты (`renderDateSelect`/`renderTimeSelect`) строят HTML с
  `onclick="toggleCustomSelect(this)"`/`onclick="toggleCustomDate(this)"` -
  интерактивность живёт в `mockup-crm.js` (классический не-module скрипт).
  Это HTML-атрибут `onclick`, он ВСЕГДА резолвится через глобальный scope -
  платформенное ограничение браузера, не наша архитектура. Трогать нельзя без
  смены модели виджета (вне скоупа structural-only рефакторинга).
- `updateNoShowUi()` (определена в `mockup-crm.js`, классический скрипт) вызывается
  из бывшего crm-auth.js как голый идентификатор, резолвящийся через общий `window`.
  Меняю на `window.updateNoShowUi()` - тот же рантайм-эффект, но зависимость видна
  в тексте кода.
