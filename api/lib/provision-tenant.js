// Подключение арендатора при старте приложения (Окно 69, 26.08.2026,
// plans/2026-08-26-podklyuchenie-arendatora.md).
//
// Зачем это существует. База Amvera живёт во внутренней сети: ни psql, ни pg_dump
// снаружи не дотянутся. Роута, заводящего арендатора, нет и осознанно не заводится -
// дверь, за которой создаются владельцы кабинетов, не менее лакомая цель, чем роут,
// отдающий базу целиком. Миграции по правилу проекта только про схему. Оставался
// механизм, которым на этом проекте уже правятся LIVE_EVENTS и BACKUP_TOKEN:
// переменная в панели плюс перезапуск.
//
// Тот же приём в индустрии - бутстрап первого администратора Keycloak
// (KC_BOOTSTRAP_ADMIN_USERNAME/PASSWORD) с тем же требованием идемпотентности.
//
// Здесь же разрывается замкнутый круг первого владельца: POST /staff требует роль
// management ТОГО ЖЕ арендатора, а у нового арендатора сотрудников нет вовсе.
// Владелец рождается служебным механизмом при старте - права роута не ослабляются.
//
import { randomBytes } from 'node:crypto';
import { pool, runInTenant } from './db.js';
import { SYSTEM_TENANT } from './tenant-context.js';
import { normalizeDomain, clearTenantCache } from './tenants.js';
import { MODULE_DEFAULTS, MODULE_KEYS } from './vertical-modules.js';
import { hashPin } from './auth.js';
import { normalizeEmail, isValidPin, newTemporaryPin } from '../routes/staff.js';

export class TenantSpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantSpecError';
  }
}

const fail = (message) => {
  throw new TenantSpecError(`NEW_TENANT: ${message}`);
};

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// Незнакомый ключ - отказ, а не молчаливый пропуск. Тихо проигнорированное поле
// означает, что человек уверен, будто задал одно, а получил другое: заводя клиента
// раз в жизни, проверить это он сможет только по факту.
function rejectUnknownKeys(where, object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(`${where}: незнакомый ключ «${key}». Ожидались: ${allowed.join(', ')}`);
  }
}

function requireText(where, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) fail(`${where} обязательно и не может быть пустым`);
  return text;
}

// Домен определяет арендатора: ошибка здесь означает «Карина открыла кабинет Алихана»
// либо 404 у реального клиента. Поэтому домен обязан приехать уже голым - без схемы,
// пути и заглавных букв. Молча «поправить» его нельзя: поправленный домен может
// оказаться не тем, который человек имел в виду.
//
// Кириллица отсекается явным списком разрешённых символов, а не доверием к
// normalizeDomain: «с» и «е» стоят в раскладке рядом с латинскими, и домен с одной
// кириллической буквой выглядит совершенно нормальным.
const BARE_DOMAIN = /^[a-z0-9.-]+(:\d+)?$/;

function parseDomains(value) {
  if (!Array.isArray(value) || value.length === 0) fail('domains: нужен непустой список доменов арендатора');
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) fail('domains: домен должен быть непустой строкой');
    const domain = raw.trim();
    if (!BARE_DOMAIN.test(domain) || normalizeDomain(domain) !== domain) {
      fail(`domains: домен «${domain}» записан не голым. Нужен вид crm.example.ru - без https://, без пути, строчными латинскими буквами`);
    }
    if (out.includes(domain)) fail(`domains: домен «${domain}» указан дважды`);
    out.push(domain);
  }
  return out;
}

function parseOwner(value) {
  if (!isPlainObject(value)) fail('owner: нужен объект с именем и почтой владельца');
  rejectUnknownKeys('owner', value, ['name', 'email', 'pin', 'providesServices']);
  const name = requireText('owner.name (имя владельца)', value.name);
  const email = normalizeEmail(value.email);
  if (!email) fail('owner.email: почта владельца не похожа на почту. В этой системе почта - только логин, письма никуда не уходят');
  if (value.pin !== undefined && !(typeof value.pin === 'string' && isValidPin(value.pin))) {
    fail('owner.pin: PIN задаётся строкой из шести цифр. Не задан - будет сгенерирован и напечатан в лог один раз');
  }
  if (value.providesServices !== undefined && typeof value.providesServices !== 'boolean') {
    fail('owner.providesServices: ожидалось true или false');
  }
  return {
    name,
    email,
    pin: value.pin === undefined ? null : value.pin,
    // Умолчание - принимает. Владелец, который не принимает клиентов, встретит свой
    // кабинет расписанием без единого мастера, и это худшее первое впечатление из
    // возможных. Выключается явным false.
    providesServices: value.providesServices !== false,
  };
}

function parseServices(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('services: ожидался список процедур');
  return value.map((raw, index) => {
    const where = `services[${index}]`;
    if (!isPlainObject(raw)) fail(`${where}: ожидался объект процедуры`);
    rejectUnknownKeys(where, raw, ['name', 'durationMin', 'price', 'category']);
    const name = requireText(`${where}.name (название процедуры)`, raw.name);
    if (!Number.isInteger(raw.durationMin) || raw.durationMin <= 0) {
      fail(`${where}.durationMin: длительность - целое число минут больше нуля`);
    }
    if (!Number.isInteger(raw.price) || raw.price < 0) {
      fail(`${where}.price: цена - целое число рублей, не меньше нуля`);
    }
    // CHECK в схеме знает ровно две категории, и от них считается зарплата
    if (raw.category !== undefined && raw.category !== 'base' && raw.category !== 'complex') {
      fail(`${where}.category: категория бывает только base или complex`);
    }
    return { name, durationMin: raw.durationMin, price: raw.price, category: raw.category ?? 'base' };
  });
}

// Тот же принцип, что у normalizeTenantModules: берём только известные ключи и только
// настоящие true/false. Разница в том, что там мусор из базы молча отбрасывается, а
// здесь человек прямо сейчас задаёт значение руками - и обязан узнать об опечатке.
function parseModules(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail('modules: ожидался объект с флагами разделов');
  rejectUnknownKeys('modules', value, MODULE_KEYS);
  const out = {};
  for (const key of MODULE_KEYS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') fail(`modules.${key}: ожидалось true или false`);
    out[key] = value[key];
  }
  return out;
}

// null означает «заводить некого»: переменная не задана или пуста. Это штатное
// состояние - в панели она живёт только на время подключения клиента.
export function parseTenantSpec(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    fail(`не разобрался JSON - ${error.message}`);
  }
  if (!isPlainObject(parsed)) fail('ожидался объект JSON с описанием арендатора');
  rejectUnknownKeys('верхний уровень', parsed, ['name', 'domains', 'vertical', 'owner', 'services', 'modules']);
  const name = requireText('name (название заведения)', parsed.name);
  const verticals = Object.keys(MODULE_DEFAULTS);
  if (typeof parsed.vertical !== 'string' || !verticals.includes(parsed.vertical)) {
    fail(`vertical: неизвестная вертикаль «${parsed.vertical}». Известны: ${verticals.join(', ')}`);
  }
  return {
    name,
    domains: parseDomains(parsed.domains),
    vertical: parsed.vertical,
    owner: parseOwner(parsed.owner),
    services: parseServices(parsed.services),
    modules: parseModules(parsed.modules),
  };
}

// Что именно будет создано - человеческими словами. PIN здесь не печатается
// сознательно: этим описанием как раз и проверяют заявку ДО перезапуска, в том числе
// когда PIN задан руками ровно ради того, чтобы он не уехал в лог приложения.
export function describeTenantSpec(spec) {
  const lines = [
    `Заведение: ${spec.name}`,
    `Вертикаль: ${spec.vertical}`,
    `Домены кабинета: ${spec.domains.join(', ')}`,
    `Владелец: ${spec.owner.name} <${spec.owner.email}>, роль owner, ${spec.owner.providesServices ? 'принимает клиентов' : 'клиентов не принимает'}`,
    `PIN владельца: ${spec.owner.pin ? 'задан в переменной (в лог не попадёт)' : 'будет сгенерирован и напечатан в лог один раз'}`,
    spec.services.length
      ? `Процедуры (${spec.services.length}): ${spec.services.map((s) => `${s.name} - ${s.durationMin} мин, ${s.price} руб.`).join('; ')}`
      : 'Процедуры: ни одной',
    Object.keys(spec.modules).length
      ? `Флаги разделов: ${Object.entries(spec.modules).map(([k, v]) => `${k}=${v}`).join(', ')}`
      : 'Флаги разделов: как по умолчанию для вертикали (включено всё)',
  ];
  return lines.join('\n');
}

// ── Запись в базу ───────────────────────────────────────────────────────────
//
// Одна транзакция в служебном контексте, целиком. Половина арендатора - клиника без
// владельца или владелец без клиники - хуже, чем отсутствие арендатора: первое
// придётся разбирать руками в базе, к которой снаружи не подключиться.
//
// Арендатор в каждой вставке проставляется ЯВНО. Умолчание колонки (миграция 057) -
// current_setting('app.tenant_id'), а в служебном контексте там '*', и вставка без
// явного значения упала бы на приведении к integer.
export async function provisionTenant(spec, out = console) {
  return runInTenant(SYSTEM_TENANT, async () => {
    // Пересечение списков, а не первый домен: заявка с чужим доменом (например с
    // доменом Алихана) обязана упереться в занятость, а не увести его себе.
    const existing = await pool.query(
      'SELECT id, name FROM tenants WHERE domains && $1::text[] LIMIT 1',
      [spec.domains]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      out.log(`Арендатор с такими доменами уже подключён: id=${row.id}, «${row.name}». Ничего не менялось`);
      return { created: false, tenantId: row.id, staffId: null, temporaryPin: null };
    }

    const tenant = await pool.query(
      'INSERT INTO tenants (name, domains, vertical, modules) VALUES ($1, $2::text[], $3, $4::jsonb) RETURNING id',
      [spec.name, spec.domains, spec.vertical, JSON.stringify(spec.modules)]
    );
    const tenantId = tenant.rows[0].id;

    // PIN, заданный в переменной, наружу не возвращается: его и задают руками ровно
    // затем, чтобы секрет не уехал в лог приложения.
    const pin = spec.owner.pin ?? newTemporaryPin();
    const staffId = `staff-${randomBytes(12).toString('hex')}`;
    await pool.query(
      `INSERT INTO staff (id, tenant_id, name, email, role, employed, provides_services, has_system_access, pin_hash, must_change_pin, protected_owner)
       VALUES ($1, $2, $3, $4, 'owner', true, $5, true, $6, true, true)`,
      [staffId, tenantId, spec.owner.name, spec.owner.email, spec.owner.providesServices, hashPin(pin)]
    );

    for (const [index, service] of spec.services.entries()) {
      const serviceId = `service-${randomBytes(12).toString('hex')}`;
      await pool.query(
        'INSERT INTO services (id, tenant_id, name, category, duration_min, price, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [serviceId, tenantId, service.name, service.category, service.durationMin, service.price, index + 1]
      );
      // Процедура, которую никто не делает, не появится ни в записи, ни в расписании.
      // Владелец на старте единственный, поэтому обе процедуры - его; остальных врачей
      // и их компетенции заводит уже сам клиент из кабинета.
      if (spec.owner.providesServices) {
        await pool.query(
          'INSERT INTO master_services (tenant_id, master_id, service_id, price, duration_min) VALUES ($1, $2, $3, $4, $5)',
          [tenantId, staffId, serviceId, service.price, service.durationMin]
        );
      }
    }

    // Отрицательный ответ по домену живёт в памяти минуту (TENANT_CACHE_TTL_MS).
    // Заводим арендатора до listen, но сбрасываем явно: механизм не должен зависеть
    // от того, в каком порядке это когда-нибудь переставят.
    clearTenantCache();
    out.log(`Арендатор подключён: id=${tenantId}, «${spec.name}», домены ${spec.domains.join(', ')}, владелец ${spec.owner.email}, процедур ${spec.services.length}`);
    return { created: true, tenantId, staffId, temporaryPin: spec.owner.pin ? null : pin };
  });
}

// Точка входа для старта приложения. НИКОГДА не бросает: опечатка в переменной,
// относящейся к другому клиенту, не должна ронять живой салон Алихана. Требование
// fail-closed этим не нарушается - оно про атомарность заведения, а не про
// доступность приложения. Опечатка ловится раньше, tools/check-new-tenant.mjs.
export async function provisionTenantFromEnv(raw, out = console) {
  let spec;
  try {
    spec = parseTenantSpec(raw);
  } catch (error) {
    out.error(`${error.message}. Арендатор НЕ заведён, приложение работает как прежде`);
    return null;
  }
  if (!spec) return null;
  try {
    const result = await provisionTenant(spec, out);
    if (result.created && result.temporaryPin) {
      out.log(`Временный PIN владельца ${spec.owner.email}: ${result.temporaryPin} - сменить при первом входе, переменную NEW_TENANT убрать из панели и перезапустить приложение`);
    }
    return result;
  } catch (error) {
    out.error(`NEW_TENANT: заведение арендатора не прошло - ${error.message}. В базе ничего не создано, приложение работает как прежде`);
    return null;
  }
}
