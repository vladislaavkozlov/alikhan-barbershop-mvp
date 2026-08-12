export const TEAM_SECTION_ORDER = [
  'Основное',
  'Профиль на сайте',
  'Услуги и время',
  'График',
  'Доступ',
];

export const MANAGEMENT_ROLES = ['owner', 'manager'];
export const BOOKING_OPERATOR_ROLES = ['owner', 'manager', 'admin'];
export const ASSIGNABLE_ROLES = ['master', 'admin', 'manager'];

export const STAFF_CONTRACT_FIELDS = [
  'id', 'locationId', 'name', 'phone', 'email', 'role', 'employed',
  'providesServices', 'hasSystemAccess', 'publicProfileEnabled',
];

export const PUBLIC_MASTER_FORBIDDEN_FIELDS = [
  'phone', 'email', 'role', 'pin', 'pinHash', 'hasSystemAccess', 'employed',
];
