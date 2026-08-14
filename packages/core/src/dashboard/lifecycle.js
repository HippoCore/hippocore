import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getHippoHome } from '../config.js';

export function dashboardPidPath(env = process.env) {
  return join(getHippoHome(env), 'dashboard.pid');
}

export function dashboardStatus(env = process.env) {
  const path = dashboardPidPath(env);
  if (!existsSync(path)) return { running: false, pid: null, path };
  const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, pid: null, path };
  try {
    process.kill(pid, 0);
    return { running: true, pid, path };
  } catch {
    rmSync(path, { force: true });
    return { running: false, pid: null, path };
  }
}

export function startDashboardBackground(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const current = dashboardStatus(env);
  if (current.running) return { ...current, changed: false };
  const cli = fileURLToPath(new URL('../cli/index.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'dashboard', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  writeFileSync(dashboardPidPath(env), `${child.pid}\n`, { mode: 0o600 });
  return { running: true, pid: child.pid, path: dashboardPidPath(env), changed: true };
}

export function stopDashboardBackground(env = process.env) {
  const current = dashboardStatus(env);
  if (!current.running) return { ...current, changed: false };
  try { process.kill(current.pid); } catch {}
  rmSync(current.path, { force: true });
  return { running: false, pid: current.pid, path: current.path, changed: true };
}
