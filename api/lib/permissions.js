export const MANAGEMENT_ROLES = ['owner', 'manager'];
export const BOOKING_OPERATOR_ROLES = ['owner', 'manager', 'admin'];
export const ASSIGNABLE_ROLES = ['master', 'admin', 'manager'];

export const canManageStaff = (auth) => !!auth && MANAGEMENT_ROLES.includes(auth.role);
export const isAssignableRole = (role) => ASSIGNABLE_ROLES.includes(role);

// Protected owner is an immutable bootstrap account. Its role, access and
// employment status cannot be changed by any API caller, including itself
export const canMutateProtectedOwner = (_auth, target) => !target?.protectedOwner;
