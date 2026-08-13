export const MANAGEMENT_ROLES = ['owner', 'manager'];
export const BOOKING_OPERATOR_ROLES = ['owner', 'manager', 'admin'];
// Операторы записи ПЛЮС мастер: роуты, которые мастер тоже вызывает, но только по
// своей записи/своему клиенту (проверка "своё" живёт дальше в самом обработчике,
// auth.role === 'master' && booking.master_id !== auth.id → 403).
// Заведено 13.08.2026: четыре таких роута остались с руками написанным
// ['owner','admin','master'] и не получили роль manager, когда её вводило Окно 57 -
// управляющий ловил 401 на смене статуса визита прямо в карточке записи (нашёл Влад
// на проде). Литерал в этих местах и был причиной: список ролей, размноженный
// копией, расходится с общим при первой же новой роли.
export const BOOKING_STAFF_ROLES = [...BOOKING_OPERATOR_ROLES, 'master'];
export const ASSIGNABLE_ROLES = ['master', 'admin', 'manager'];

export const canManageStaff = (auth) => !!auth && MANAGEMENT_ROLES.includes(auth.role);
export const isAssignableRole = (role) => ASSIGNABLE_ROLES.includes(role);

// Protected owner is an immutable bootstrap account. Its role, access and
// employment status cannot be changed by any API caller, including itself
export const canMutateProtectedOwner = (_auth, target) => !target?.protectedOwner;

// Замок защищённого владельца сужен 13.08.2026: он защищает ровно то, что может
// запереть систему (роль, доступ в систему, трудоустройство), а не всю карточку.
// До этого 403 отдавался на весь PUT /staff/:id - владелец не мог сохранить у себя
// ни имя, ни телефон, ни тумблер витрины ("Не удалось сохранить. Повторите попытку"
// в разделе Команда), при том что UI показывал поля редактируемыми.
// Роль по-прежнему меняется только через PUT /staff/:id/role, где замок цел.
//
// Два случая, когда рабочий статус и доступ форсятся включёнными:
//   protectedOwner - владелец, у него это неотчуждаемо (в том числе от управляющего)
//   isSelf         - никто не снимает статус сам с себя, иначе управляющий одним
//                    случайным тумблером выкидывает себя из CRM без пути назад
// Проверка живёт на сервере, а не только в интерфейсе: заблокированный тумблер
// защищает от промаха мышью, но не от прямого запроса к API.
export function guardAccountLockout(target, requested) {
  if (!target?.protectedOwner && !target?.isSelf) return requested;
  return { ...requested, employed: true, hasSystemAccess: true };
}
