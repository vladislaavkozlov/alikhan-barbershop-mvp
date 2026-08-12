import { sendJson } from '../lib/http.js';
import { pool } from '../lib/db.js';
export async function handlePublicMasters(_req, res) {
  const rows = await pool.query(`SELECT s.id,s.name,s.photo_url,s.experience_text,s.strengths_text,s.certificates_text,sm.id AS media_id,sm.kind,sm.storage_key,sm.sort_order FROM staff s LEFT JOIN staff_media sm ON sm.staff_id=s.id WHERE s.employed=true AND s.provides_services=true AND s.public_profile_enabled=true AND EXISTS (SELECT 1 FROM master_services ms WHERE ms.master_id=s.id) AND EXISTS (SELECT 1 FROM master_weekly_schedule ws WHERE ws.master_id=s.id AND ws.is_working=true) ORDER BY s.name,sm.sort_order,sm.created_at`);
  const masters=new Map(); for(const r of rows.rows){ if(!masters.has(r.id)) masters.set(r.id,{id:r.id,name:r.name,photoUrl:r.photo_url,experienceText:r.experience_text,strengthsText:r.strengths_text,certificatesText:r.certificates_text,portfolio:[],services:[]}); const item=masters.get(r.id); if(r.storage_key){const url=`/media/${r.storage_key}`; if(r.kind==='avatar') item.photoUrl=url; else item.portfolio.push({id:r.media_id,url});} }
  const ids=[...masters.keys()]; if(ids.length){const services=await pool.query(`SELECT ms.master_id,s.id,s.name,ms.price,ms.duration_min FROM master_services ms JOIN services s ON s.id=ms.service_id WHERE ms.master_id=ANY($1) ORDER BY s.name`,[ids]); for(const r of services.rows) masters.get(r.master_id).services.push({id:r.id,name:r.name,price:r.price,durationMin:r.duration_min});}
  return sendJson(res,200,[...masters.values()]);
}
