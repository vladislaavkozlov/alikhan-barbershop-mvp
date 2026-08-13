export const MANAGEMENT_ROLES = ['owner', 'manager'];
export const BOOKING_OPERATOR_ROLES = ['owner', 'manager', 'admin'];
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
