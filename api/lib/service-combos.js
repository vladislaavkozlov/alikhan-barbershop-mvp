// Правила комплексных услуг НА СЕРВЕРЕ (Влад, 16.08.2026: "если выбрать просто
// 'Борода' и 'Стрижка + борода', он позволит это сохранить").
//
// ЗЕРКАЛО storage.js (SERVICE_COMBOS) - дублируется намеренно, тем же решением, что
// и normalizePhoneKey в routes/clients.js: storage.js это фронтовый модуль в корне
// репозитория, а на Amvera уезжает только содержимое api/ - импортировать оттуда
// физически нечего. Чтобы копии не разъехались, их сверяет офлайн-тест
// tests/service-combos.mirror.test.js: он читает оба файла и сравнивает правила.
// Меняешь правило - меняй в ОБОИХ местах, тест иначе покраснеет.
export const SERVICE_COMBOS = [
  {
    comboId: 'kompleks-strizhka-boroda',
    mergeFrom: ['strizhka', 'boroda'],
    blocks: ['strizhka', 'boroda', 'britie', 'firmennaya-okantovka'],
  },
];

// Набор противоречив: комплекс и услуга, которая в него уже входит, разом. Такой
// состав означает, что клиент платит за одно и то же дважды, и до 16.08.2026 форма
// позволяла его собрать (блокировка работала только в одну сторону).
export function hasComboConflict(serviceIds) {
  const ids = new Set(serviceIds ?? []);
  return SERVICE_COMBOS.some((combo) => ids.has(combo.comboId) && combo.blocks.some((id) => ids.has(id)));
}
