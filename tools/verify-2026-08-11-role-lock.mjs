// Живая проверка замка последнего владельца (инцидент прав 11.08.2026).
//
// Бьёт в РЕАЛЬНЫЙ HTTP-роут PUT /staff/:id/role на эфемерной базе, а не в моки:
// юниты (tests/api.staff-role-lock.test.js) кроют только чистую функцию
// isLastOwnerDemotion, а сам инцидент случился на живом роуте - значит и замок
// нужно доказать живым запросом, включая порядок проверок внутри обработчика
// (requireRole → invalid_role → замок → UPDATE).
//
// Фикстуры создаются и удаляются этим же прогоном на ЭФЕМЕРНОЙ базе (правило
// проекта: QA-аккаунты не через миграции, см. CLAUDE.md). Боевые креды не нужны и
// не используются - PIN генерируется здесь же.
//
// Запуск (всё сам, база создаётся и сносится):
//   node tools/verify-2026-08-11-role-lock.mjs
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomInt, scryptSync, randomBytes } from 'node:crypto';

const run = promisify(execFile);
const DB = 'alikhan_rolelock_verify';
const PORT = 8971;
const API = `http://localhost:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`✔ ${name}`);
  } else {
    fail++;
    console.log(`✖ ${name}${extra ? ` - ${extra}` : ''}`);
  }
}

// Тот же формат, что hashPin в api/lib/auth.js (scryptSync, "salt:hash").
function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(String(pin), salt, 64).toString('hex')}`;
}

async function psql(sql) {
  const { stdout } = await run('psql', ['-t', '-A', '-d', DB, '-c', sql]);
  return stdout.trim();
}

async function api(path, method, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустое тело - не ошибка */
  }
  return { status: res.status, data };
}

async function login(email, pin) {
  const { status, data } = await api('/auth/login', 'POST', null, { email, pin });
  if (status !== 200) throw new Error(`логин ${email} → ${status}: ${JSON.stringify(data)}`);
  return data.token;
}

let server;
try {
  // ── база с нуля, все миграции накатывает сам сервер при старте ───────────────
  await run('dropdb', ['--if-exists', DB]);
  await run('createdb', [DB]);
  console.log(`база создана: ${DB}`);

  server = spawn('node', ['api/server.mjs'], {
    env: { ...process.env, DB_HOST: 'localhost', DB_NAME: DB, DB_USER: process.env.USER, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  let stderr = '';
  server.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  // Ждём, пока сервер поднимется и накатит миграции. Падение миграции валит старт
  // целиком (инцидент 031) - значит "сервер ответил по HTTP" уже доказывает, что все
  // 43 миграции, включая 043_restore_owner_role.sql, применились без ошибки.
  // Признак живости - ЛЮБОЙ HTTP-ответ, а не res.ok: /services закрыт авторизацией и
  // штатно отдаёт 401 анонимному запросу (поймано первым прогоном этого скрипта).
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${API}/services`);
      up = true;
      break;
    } catch {
      /* ещё не слушает */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`сервер не поднялся за 30с. stderr:\n${stderr}`);
  check('сервер поднялся - значит все миграции, включая 043, применились', true);

  // ── состав после миграций: ровно то, что на проде ───────────────────────────
  const roles = await psql("SELECT id || '=' || role FROM staff WHERE id LIKE 'master-%' ORDER BY id;");
  check(
    'после миграций Алиовсад - владелец (043 сработала на чистой базе)',
    roles.includes('master-1=owner'),
    roles.replace(/\n/g, ' ')
  );

  // ── фикстуры: свой владелец и свой мастер с известными PIN ──────────────────
  const OWNER_PIN = String(randomInt(1000, 9999));
  const SECOND_PIN = String(randomInt(1000, 9999));
  await psql(`
    INSERT INTO staff (id, location_id, name, role, employed, provides_services, has_system_access, email, pin_hash)
    VALUES ('rl-owner', 1, 'RL Владелец (фикстура)', 'owner', true, false, true, 'rl-owner@verify.test', '${hashPin(OWNER_PIN)}'),
           ('rl-second', 1, 'RL Второй (фикстура)', 'master', true, true, true, 'rl-second@verify.test', '${hashPin(SECOND_PIN)}');
  `);
  // Боевого владельца убираем из расчёта, чтобы фикстурный остался ЕДИНСТВЕННЫМ -
  // иначе замок честно не сработает (владельцев двое) и проверка ничего не докажет.
  await psql("UPDATE staff SET role = 'master' WHERE id = 'master-1';");
  const ownersNow = await psql("SELECT count(*) FROM staff WHERE role = 'owner';");
  check('в базе ровно один владелец - фикстурный', ownersNow === '1', `владельцев: ${ownersNow}`);

  const ownerToken = await login('rl-owner@verify.test', OWNER_PIN);

  // ── ГЛАВНЫЙ АССЕРТ: ровно тот запрос, что запер прод ────────────────────────
  const selfDemote = await api('/staff/rl-owner/role', 'PUT', ownerToken, { role: 'master' });
  check(
    'единственный владелец НЕ может снять роль с себя (409 last_owner_role_locked)',
    selfDemote.status === 409 && selfDemote.data?.error === 'last_owner_role_locked',
    `${selfDemote.status} ${JSON.stringify(selfDemote.data)}`
  );
  const stillOwner = await psql("SELECT role FROM staff WHERE id = 'rl-owner';");
  check('роль в базе не изменилась после отказа', stillOwner === 'owner', `роль: ${stillOwner}`);

  // Второй путь к тому же тупику: снять роль с другого последнего владельца.
  await psql("UPDATE staff SET role = 'owner' WHERE id = 'rl-second';");
  await psql("UPDATE staff SET role = 'master' WHERE id = 'rl-owner';");
  const secondToken = await login('rl-second@verify.test', SECOND_PIN);
  const crossDemote = await api('/staff/rl-second/role', 'PUT', secondToken, { role: 'admin' });
  check(
    'владелец не может снять роль с последнего владельца, даже действуя от его имени',
    crossDemote.status === 409,
    `${crossDemote.status} ${JSON.stringify(crossDemote.data)}`
  );

  // ── штатные сценарии не задеты замком ──────────────────────────────────────
  const grant = await api('/staff/rl-owner/role', 'PUT', secondToken, { role: 'owner' });
  check(
    'выдача роли владельца проходит (единственный путь сделать владельцев двое)',
    grant.status === 200 && grant.data?.role === 'owner',
    `${grant.status} ${JSON.stringify(grant.data)}`
  );

  const demoteWhenTwo = await api('/staff/rl-second/role', 'PUT', grant.status === 200 ? await login('rl-owner@verify.test', OWNER_PIN) : secondToken, { role: 'admin' });
  check(
    'когда владельцев двое - понижение одного разрешено',
    demoteWhenTwo.status === 200 && demoteWhenTwo.data?.role === 'admin',
    `${demoteWhenTwo.status} ${JSON.stringify(demoteWhenTwo.data)}`
  );

  const ownerToken2 = await login('rl-owner@verify.test', OWNER_PIN);
  const demoteMaster = await api('/staff/master-3/role', 'PUT', ownerToken2, { role: 'admin' });
  check(
    'смена роли НЕ-владельца проходит как раньше (регресс Окна 14 не сломан)',
    demoteMaster.status === 200 && demoteMaster.data?.role === 'admin',
    `${demoteMaster.status} ${JSON.stringify(demoteMaster.data)}`
  );

  // ── порядок проверок внутри обработчика не сломан замком ───────────────────
  const badRole = await api('/staff/master-3/role', 'PUT', ownerToken2, { role: 'god' });
  check('невалидная роль по-прежнему 400, замок не перехватывает', badRole.status === 400, `${badRole.status}`);

  const noAuth = await api('/staff/rl-owner/role', 'PUT', null, { role: 'master' });
  check('без токена по-прежнему 401, замок не перехватывает', noAuth.status === 401, `${noAuth.status}`);

  const masterToken = await login('rl-second@verify.test', SECOND_PIN); // теперь admin
  const byAdmin = await api('/staff/master-3/role', 'PUT', masterToken, { role: 'master' });
  check('админ по-прежнему не может менять роли (401)', byAdmin.status === 401, `${byAdmin.status}`);
} catch (err) {
  fail++;
  console.log(`✖ прогон упал: ${err.message}`);
} finally {
  if (server) server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  try {
    await run('dropdb', ['--if-exists', DB]);
    console.log(`база снесена: ${DB}`);
  } catch (err) {
    console.log(`не удалось снести базу ${DB}: ${err.message}`);
  }
  console.log(`\nИТОГ: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
