# Plan: Панели, запись и вход CRM
**Spec:** specs/2026-08-12-crm-panels-booking-login.md
**Status:** completed

## Challenge Log
**Problem:** Четыре связанных UI-дефекта затрагивают общую навигационную систему и разные роли
**Chosen solution:** Расширить существующий слой `crm-navigation-ui`, добавить один идемпотентный controller панелей и переиспользовать уже рабочую форму записи
**Alternatives considered:**
1. Вставить отдельные кнопки и обработчики в каждую страницу - отклонено из-за дублирования и риска расхождения поведения
2. Создать вторую форму записи специально для новой панели - отклонено из-за двух источников состояния и повторения уже устранённой ошибки двух форм
3. Ослабить права мастера и показать ему запись - отклонено, потому что противоречит подтверждённому процессу и серверному RBAC
**Why chosen solution is better:** Один scoped-controller обслуживает существующий DOM-контракт, а одна форма остаётся единственным источником создания и редактирования записи

## Problems

| # | Problem | Solution | Status |
|---|---------|----------|--------|
| 1 | Панели раскрываются только отдельно | Контекстная кнопка над каждым списком + синхронизация по `toggle` | completed |
| 2 | Новую запись нельзя начать без клика по слоту | Панель «Запись» owner/admin открывает существующую форму в create-mode | completed |
| 3 | Вход не соответствует CRM | Scoped-разметка и CSS на тех же токенах | completed |
| 4 | У мастера пилюли и дубль сообщений | Перевести три вида в panels, убрать конверт и год | completed |

## Phases

### Phase 1: Контракты и общий controller
- **Status:** completed
- **Files:** `tests/crm-navigation-panels.contract.test.js`, `tests/crm-panels-interactions.test.js`, `assets/crm-navigation-panels.js`
- **Changes:** Зафиксировать требования тестами и реализовать общий controller
- **TDD:** Сначала падающие DOM/source contracts, затем реализация
- **Gates:** node test
- **Impact:** Все списки `staff-card` в трёх CRM-страницах

### Phase 2: Расписание и права ролей
- **Status:** completed
- **Files:** `crm-owner.html`, `crm-admin.html`, `crm-master.html`, `assets/crm-walkin.js`, `assets/crm-schedule-views.js`
- **Changes:** Панель записи owner/admin, панели расписания master, удаление дубля уведомлений
- **TDD:** Контракты разметки ролей и вызова существующей формы
- **Gates:** node test + verify script
- **Impact:** Загрузка видов расписания, создание и редактирование записи

### Phase 3: Вход и визуальная проверка
- **Status:** completed
- **Files:** `assets/crm-auth.js`, `assets/crm-navigation-panels.css`, `docs/design/crm-navigation-panels.md`, verify script
- **Changes:** Новый вид login gate, responsive-полировка и документация
- **TDD:** Контракт структуры/скоупа и отсутствие тестового текста
- **Gates:** все тесты + desktop/mobile smoke
- **Impact:** Только CRM login overlay

## Changelog

| Date | Phase | Changes |
|------|-------|---------|
| 2026-08-12 | План | Зафиксированы scope, права и критерии приёмки |
| 2026-08-12 | Реализация | Добавлены controller панелей, ручная запись owner/admin, три панели мастера, единый колокольчик и новый login |
| 2026-08-12 | Проверка | 225 независимых тестов зелёные; 15 новых контрактов зелёные; 17 browser smoke-проверок desktop/mobile зелёные |
