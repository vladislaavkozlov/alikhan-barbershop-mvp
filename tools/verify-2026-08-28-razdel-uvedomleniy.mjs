// Живой прогон правок 28.08.2026: раздел «Уведомления» во всех трёх кабинетах,
// график только у владельца и управляющего, надписи про увольнение убраны.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { withBrowser } from './cdp.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8797;
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png','.webmanifest':'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('нет'); }
});
await new Promise((r) => server.listen(PORT, r));

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

await withBrowser(async (s) => {
  for (const page of ['crm-owner.html', 'crm-admin.html', 'crm-master.html']) {
    await s.navigate(`http://localhost:${PORT}/${page}`);
    await s.setViewport(390, 900, true);
    await new Promise((r) => setTimeout(r, 1200));

    const seen = JSON.parse(await s.eval(`JSON.stringify({
      panel: !!document.querySelector('.tab-panel.panel-e'),
      center: !!document.getElementById('notifCenter'),
      radio: !!document.getElementById('pt-e'),
      pushHosts: document.querySelectorAll('[data-push-host]').length,
      bell: !!document.getElementById('msgBell')
    })`));

    check(`${page}: раздел уведомлений есть в разметке`, seen.panel === true);
    check(`${page}: контейнер ленты уведомлений есть`, seen.center === true);
    check(`${page}: переключатель раздела есть`, seen.radio === true);
    check(`${page}: карточка «на телефон» ровно одна`, seen.pushHosts === 1, String(seen.pushHosts));
    check(`${page}: колокольчик на месте`, seen.bell === true);
  }

  // Меню собирается модулем оболочки - проверяем сам конфиг ролей
  const shell = await s.eval(`fetch('assets/crm-app-shell.js').then(r => r.text()).then(t => JSON.stringify({
    admin: /order: \\['schedule', 'team', 'notifications', 'profile'\\]/.test(t),
    master: /order: \\['today', 'notifications', 'profile'\\]/.test(t)
  }))`, true);
  const menu = JSON.parse(shell);
  check('в меню администратора появился пункт «Уведомления»', menu.admin === true);
  check('в меню мастера появился пункт «Уведомления»', menu.master === true);

  const team = await s.eval(`fetch('assets/crm-team.js').then(r => r.text()).then(t => JSON.stringify({
    scheduleEditors: /const SCHEDULE_EDITORS = \\['owner', 'manager'\\]/.test(t),
    sectionGuarded: /canManage \\? section\\('График'/.test(t),
    noFireNote: !/payroll-note">\\$\\{staff\\.protectedOwner \\? 'Владельца уволить нельзя'/.test(t),
    noScheduleOnlyButton: !/data-save[^>]*data-schedule-only/.test(t)
  }))`, true);
  const t = JSON.parse(team);
  check('график правят только владелец и управляющий', t.scheduleEditors === true);
  check('секция графика показывается только им', t.sectionGuarded === true);
  check('надписи про невозможность увольнения убраны', t.noFireNote === true);
  check('кнопки «Сохранить график» у администратора больше нет', t.noScheduleOnlyButton === true);
});

server.close();
let failed = 0;
for (const c of checks) { if (!c.ok) failed++; console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` - получили: ${c.detail}`}`); }
console.log(`\n${checks.length - failed} из ${checks.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
