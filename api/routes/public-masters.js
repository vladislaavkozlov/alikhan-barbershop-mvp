import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';

// Кого показываем публично = кого реально можно записать: работает, оказывает услуги,
// услуги ему назначены и есть рабочий график. Флаг staff.public_profile_enabled сюда
// НЕ входит осознанно (исправлено 13.08.2026): он управляет только витриной профиля
// (стаж, сильные стороны, сертификаты, фото работ), а не доступностью записи. Пока он
// стоял в WHERE, выключенный тумблер убирал мастера из формы записи целиком - после
// релиза 12.08 (миграция 046 с DEFAULT false) так пропали все действующие мастера.
const PUBLIC_MASTERS_SQL = `SELECT s.id,s.name,s.photo_url,s.experience_text,s.strengths_text,s.certificates_text,s.public_profile_enabled,sm.id AS media_id,sm.kind,sm.storage_key,sm.sort_order FROM staff s LEFT JOIN staff_media sm ON sm.staff_id=s.id WHERE s.employed=true AND s.provides_services=true AND EXISTS (SELECT 1 FROM master_services ms WHERE ms.master_id=s.id) AND EXISTS (SELECT 1 FROM master_weekly_schedule ws WHERE ws.master_id=s.id AND ws.is_working=true) ORDER BY s.name,sm.sort_order,sm.created_at`;

const MASTER_SERVICES_SQL = `SELECT ms.master_id,s.id,s.name,ms.price,ms.duration_min FROM master_services ms JOIN services s ON s.id=ms.service_id WHERE ms.master_id=ANY($1) ORDER BY s.name`;

// Чистая сборка ответа - без БД и HTTP, чтобы правило "флаг режет только профиль,
// не присутствие мастера" проверялось юнитом (тот же приём, что у computeMasterPayroll).
// Аватар профилем не считается: это лицо мастера в списке выбора, а не витрина работ.
export function buildPublicMasters(masterRows, serviceRows = []) {
  const masters = new Map();
  for (const r of masterRows) {
    if (!masters.has(r.id)) {
      const showProfile = r.public_profile_enabled === true;
      masters.set(r.id, {
        id: r.id,
        name: r.name,
        photoUrl: r.photo_url,
        publicProfileEnabled: showProfile,
        experienceText: showProfile ? r.experience_text : null,
        strengthsText: showProfile ? r.strengths_text : null,
        certificatesText: showProfile ? r.certificates_text : null,
        portfolio: [],
        services: [],
      });
    }
    const item = masters.get(r.id);
    if (r.storage_key) {
      const url = `/media/${r.storage_key}`;
      if (r.kind === 'avatar') item.photoUrl = url;
      else if (item.publicProfileEnabled) item.portfolio.push({ id: r.media_id, url });
    }
  }
  for (const r of serviceRows) {
    masters.get(r.master_id)?.services.push({ id: r.id, name: r.name, price: r.price, durationMin: r.duration_min });
  }
  return [...masters.values()];
}

export async function handlePublicMasters(_req, res) {
  const rows = await pool.query(PUBLIC_MASTERS_SQL);
  const ids = [...new Set(rows.rows.map((r) => r.id))];
  const services = ids.length ? await pool.query(MASTER_SERVICES_SQL, [ids]) : { rows: [] };
  return sendJson(res, 200, buildPublicMasters(rows.rows, services.rows));
}
