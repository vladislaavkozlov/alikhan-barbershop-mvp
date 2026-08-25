// Условия, на которых сделана запись (20.08.2026, задача Влада: «у записи должен быть
// по умолчанию комментарий - откуда пришёл клиент и на каких условиях, например
// "запись к топ-мастеру"»).
//
// Почему это вычисляемая строка, а не текст в bookings.staff_comment:
//   1) staff_comment - место сотрудника («владелец дал скидку», миграция 048), и
//      автоподстановка затирала бы написанное человеком;
//   2) тариф записи пересчитывается при смене состава услуг и переносе к другому
//      мастеру (refreshMasterTier, api/routes/bookings.js) - однажды записанный текст
//      после такого пересчёта врал бы, а строка, собранная из полей, всегда актуальна.
//
// Оба поля приезжают с /bookings готовыми (clientSource, masterTier), здесь только
// человеческие подписи - тот же приём, что у CLIENT_SOURCE_LABELS.
import { clientSourceLabel } from './client-source.js';
import { T, Tc, P, C } from './crm-terms.js';

// Ключи зеркалят MASTER_TIERS на сервере (api/routes/bookings.js). Значения, которых
// здесь нет (старая бронь с NULL, будущий 'vip' до того, как его сюда допишут), дают
// null - карточка тогда просто не показывает условий, вместо машинного ключа на экране.
// Собирается вызовом, не константой: см. ту же оговорку в renew-reason.js
export const masterTierLabels = () => ({
  top: P('booking.topTariff'),
  standard: 'обычный тариф',
});

export function masterTierLabel(tier) {
  return masterTierLabels()[tier] ?? null;
}

// «Яндекс Карты · запись к топ-мастеру». Разделитель - та же точка, что уже разделяет
// клиента и услугу в карточке дня. Нет ни канала, ни тарифа - null, а не пустая строка:
// подпись без содержимого читается как потерянные данные.
export function bookingTermsLabel({ clientSource, masterTier } = {}) {
  const parts = [clientSourceLabel(clientSource), masterTierLabel(masterTier)].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
