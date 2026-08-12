import { el } from './crm-shared.js';

function initials(name = '') {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || '--';
}

function setValue(id, value) {
  const node = el(id);
  if (node) node.value = value || '—';
}

export function wireAdminSelfData(staff, staffList) {
  const current = staffList.find((row) => row.id === staff.id) || staff;
  const name = current.name || staff.name || 'Администратор';
  const nameEl = el('adminSelfName');
  const avatarEl = el('adminSelfAvatar');
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) avatarEl.textContent = initials(name);
  setValue('adminSelfPhone', current.phone || staff.phone);
  setValue('adminSelfEmail', current.email || staff.email);

  const elizaveta = staffList.find((row) => row.id === 'master-3');
  if (elizaveta) {
    setValue('adminStaffPhone-master-3', elizaveta.phone);
    setValue('adminStaffEmail-master-3', elizaveta.email);
  }
}
