# Декомпозиция api/server.mjs — Этап 2 структурного рефакторинга

Продолжение Этапа 1 (`plans/2026-08-07-crm-auth-decomposition.md`, закрыт 07.08.2026).
Контекст и обоснование - `plans/2026-08-07-server-mjs-decomposition-handoff.md`.

## Правила (те же, что Этап 1, буквально)
1. Поведение/дизайн/бизнес-логика/API-контракты не меняются.
2. Код переносится, не переписывается (переносим тела функций как есть).
3. По одному домену/слою за раз, отдельный коммит на каждый.
4. После каждого переноса - `node --check` на тронутые файлы + `node --test`.
5. Baseline ДО начала: **149 pass / 6 fail** (`node --test`, снято 07.08.2026 живьём).
   Все 6 падений - `tests/api.roles.test.js`, причина `master_not_bookable` (бьёт в
   реальный прод Amvera). Известный, задокументированный хвост. После каждой фазы
   сверяю: 149 pass остаётся 149 (не меньше), 6 fail остаются той же причиной
   `master_not_bookable` (не новая).
6. Не улучшать попутно, не менять сигнатуры экспортируемых для тестов функций
   (`toMinutes`, `isoWeekday`, `enumerateDateRange`, `getEffectiveSchedule`,
   `filterStaffForViewer`, `mastersWithWorkingSchedule`, `hasAvailableSlot`,
   `isScheduleDayOff`, `rangeDayCount`, `computeScheduleRangeDays`,
   `computeAvailabilityRangeDays`, `computeMasterNextAvailability`,
   `computeMasterPayroll`, `computeRevenueToday`, `describeClientRisk`,
   `getClientCard`, `listClientsAtRisk`, `findMastersMissingSchedule`,
   `notifyOwnerAboutMastersMissingSchedule`, `computeOwnerAlerts`,
   `findWeeklyScheduleConflicts`, `findScheduleConflicts`, `listHolidays`,
   `holidayCloseTargets`, `fullDayOffWindow`, `dayOffWindowsForRequest`,
   `planHolidayClose`, `SCHEDULE_RANGE_MAX_DAYS`, `SCHEDULE_AVAILABILITY_MAX_DAYS`,
   `MASTER_NEXT_AVAILABILITY_WINDOW_DAYS`, `HOLIDAY_CLOSE_MAX_DAYS`) - тесты
   импортируют их напрямую из `api/server.mjs` (`grep -n "from '.*server.mjs'"
   tests/*.test.js` подтверждает), поэтому **`server.mjs` должен продолжать
   ре-экспортировать все эти имена** после переноса (`export { X } from
   './lib/...js'`), чтобы тесты не трогать.
7. Деплой на Amvera - НЕ делать в этом плане, только по отдельной явной команде.

## Реальная карта зависимостей (не по комментариям-заголовкам, по grep вызовов
## вида `fn(` - см. сессию 07.08.2026)

Функции с вызовами из **нескольких доменов одновременно** (значит - общий lib-слой,
не файл одного домена):

| Функция | Вызывается из (домены) |
|---|---|
| `getEffectiveSchedule` | schedule, bookings (`createBookingTx`), schedule-requests (`dayOffWindowsForRequest`/`planHolidayClose`) |
| `mastersWithWorkingSchedule` | bookings (`createBookingTx`), staff (`GET /staff`), notifications (`findMastersMissingSchedule`), schedule (`master-weekly-schedule`) |
| `notifyStaff` | bookings (`createBookingTx`), notifications (`notifyOwnerAboutMastersMissingSchedule`), schedule-requests (decision/cancel), `scanBookingReminders` (server.mjs, не роут) |
| `notifyOwnerAboutMastersMissingSchedule` | auth (`/auth/login`, side-effect при входе владельца) |
| `writeWeeklySchedule`, `applyScheduleDay`, `findScheduleConflicts`, `dayOffWindowsForRequest` | schedule (`master-weekly-schedule`, `holidays/close`) И schedule-requests (`decision`, `cancel`) |
| `enumerateDateRange`, `dateColToStr`, `isoWeekday` | schedule (`listHolidays`, `holidays/close`) И schedule-requests (`decision`, `cancel`) |
| `requireRole`, `authenticate` | буквально все домены (20+/32 вызова) |

Функции с вызовом **только из одного домена** (переезжают вместе с телом роута,
не в lib):
- `createBookingTx`, `listBookingsForRequest` → только `bookings`
- `computeMasterPayroll`, `computeRevenueToday` → только `payroll`
- `computeOwnerAlerts`, `getClientCard`, `listClientsAtRisk`, `describeClientRisk`,
  `pluralRaz` → только `clients` (`pluralRaz` физически рядом с payroll-кодом в
  файле, но реально используется только `describeClientRisk` - едет в clients,
  не payroll; это единственное расхождение с "порядком по файлу")

## Целевая структура

```
api/
  server.mjs          # HTTP-сервер: CORS, парсинг URL, гейт ROUTES/authenticate,
                       # диспатч if/else (порядок и условия НЕ меняются - см. фазу 8),
                       # startServer/runMigrations/scanBookingReminders остаются здесь
  lib/
    http.js            # setCors, sendJson, readBody
    time.js            # toMinutes, minutesToTime, addMinutes, addDaysIso,
                        # intervalsOverlap, shopNow, isoWeekday, enumerateDateRange,
                        # dateColToStr
    db.js              # pool (pg Pool), casWrite
    auth.js            # hashPin, verifyPin, createSession, authenticate, requireRole
    schedule-core.js    # getEffectiveSchedule, filterStaffForViewer,
                        # mastersWithWorkingSchedule, blockedIntervalsFor,
                        # hasAvailableSlot, isScheduleDayOff, rangeDayCount,
                        # computeScheduleRangeDays, computeAvailabilityRangeDays,
                        # computeMasterNextAvailability, validateWeeklyChanges,
                        # writeWeeklySchedule, formatWeeklyChangesSummary,
                        # findWeeklyScheduleConflicts, findScheduleConflicts,
                        # applyScheduleDay, listHolidays, holidayCloseTargets,
                        # fullDayOffWindow, dayOffWindowsForRequest,
                        # planHolidayClose + 4 константы MAX_DAYS/WINDOW_DAYS
    notify-core.js      # notifyStaff, findMastersMissingSchedule,
                        # notifyOwnerAboutMastersMissingSchedule
  routes/
    auth.js            # POST /auth/login, GET /auth/me
    staff.js           # GET /staff, PUT /staff/:id/portfolio, PUT /staff/:id/role
    services.js        # GET /services, GET/PUT /master-services...
    bookings.js        # GET/POST /bookings, /bookings/:id/cancel, /:id/status,
                        # GET/POST /sales + createBookingTx, listBookingsForRequest
    schedule.js        # /schedule, /schedule-range, /holidays(+close),
                        # /schedule-availability, /masters-next-availability,
                        # /master-weekly-schedule
    schedule-requests.js  # POST/GET /schedule-requests, /:id/decision, /:id/cancel
    notifications.js   # /notifications, /unread-count, /:id/read, /read-all
    payroll.js         # /payroll-settings, /payroll, /revenue/today +
                        # computeMasterPayroll, computeRevenueToday
    clients.js         # /clients?risk=true, /clients/:id, /owner/alerts +
                        # computeOwnerAlerts, getClientCard, listClientsAtRisk,
                        # describeClientRisk, pluralRaz
  migrations/          # без изменений
```

## Формат route-хендлера (мех. правило для фаз 3-11)

Каждый инлайн-блок `if (parts[0] === 'x' && ...) { ...body... }` внутри
`createServer` становится экспортируемой `async function handleXxx(req, res, url,
parts, matchedRoute)` в своём `routes/*.js`, тело переносится 1:1 (без изменений
логики). В `server.mjs` блок сжимается до:
```js
if (parts[0] === 'x' && ...) {
  return handleXxx(req, res, url, parts, matchedRoute);
}
```
Условие-заголовок (`if (...)`) остаётся в `server.mjs` дословно - порядок диспатча
и условия матчинга не трогаем (риск регрессии в самом дешёвом месте иначе).
`req, res, url, parts` уже существуют в замыкании `server.mjs`; `matchedRoute`
передаю на случай, если тело блока к нему обращается (сверяю по факту на каждом
домене).

## Порядок фаз (снизу вверх - от изолированного к связанному)

1. `lib/http.js` (setCors/sendJson/readBody) - используется вообще всеми, но сам
   ни от чего не зависит. Первым.
2. `lib/time.js` - чистые функции, ни от чего не зависят.
3. `lib/db.js` (pool/casWrite) - `casWrite` использует `pool` изнутри.
4. `lib/auth.js` (hashPin/verifyPin/createSession/authenticate/requireRole) -
   зависит от `lib/db.js` (pool) и `lib/http.js` (не должен, проверить по факту).
5. `lib/schedule-core.js` - зависит от `lib/time.js`, `lib/db.js`. Самый большой
   перенос этой фазы (~19 функций + 4 константы), но чисто механический.
6. `lib/notify-core.js` - зависит от `lib/schedule-core.js`
   (`findMastersMissingSchedule` использует `mastersWithWorkingSchedule`).
7. `routes/auth.js`, `routes/staff.js`, `routes/services.js` - три маленьких
   домена, низкий риск, можно одним коммитом или тремя подряд (решаю по ходу
   размера диффа).
8. `routes/bookings.js` (самый крупный домен, ~430 строк + 2 функции).
9. `routes/schedule.js` (самый крупный по строкам, ~670 строк).
10. `routes/schedule-requests.js`.
11. `routes/notifications.js`, `routes/payroll.js`, `routes/clients.js`.
12. Финал: в `server.mjs` добавить `export { ... } from './lib/...'` для всех
    имён, которые напрямую импортируют тесты (список - правило 6 выше), сверить
    живым grep тестовых импортов. `node --check` на весь дерево, полный
    `node --test`, сверка с baseline 149/6.

После каждой фазы - коммит, сообщение вида `refactor(server): вынести <домен> в
routes/lib (Этап 2, фаза N)`.

## Проверка после каждой фазы
```bash
node --check api/server.mjs api/routes/*.js api/lib/*.js 2>/dev/null
node --test
# сверить: pass >= 149 (не меньше), fail == 6 и все с master_not_bookable
```
Живой CDP/curl-прогон на реальной БД - в конце всей декомпозиции (фаза 12), не
после каждой фазы (Amvera не трогаем, локальный Postgres нужен один раз в конце
для сквозной проверки, не 12 раз).

## Что НЕ делаем в этом плане
- Не меняем `ROUTES` реестр и `matchRoute`.
- Не меняем `runMigrations`/`scanBookingReminders`/`startServer` - остаются в
  `server.mjs` как были (не роуты, а инфраструктура сервера).
- Не трогаем `migrations/`.
- Не деплоим.
