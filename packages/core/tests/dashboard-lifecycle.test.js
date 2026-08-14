import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardPidPath, dashboardStatus, stopDashboardBackground } from '../src/dashboard/lifecycle.js';

test('dashboard lifecycle recognizes and stops a managed process without touching the vault', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-dashboard-'));
  const env = { HIPPO_CORE_HOME: home };
  try {
    mkdirSync(home, { recursive: true });
    const vault = join(home, 'memory.db');
    writeFileSync(vault, 'keep');
    writeFileSync(dashboardPidPath(env), `${process.pid}\n`);
    assert.equal(dashboardStatus(env).running, true);
    const originalKill = process.kill;
    process.kill = (pid, signal) => signal === 0 ? true : true;
    try { assert.equal(stopDashboardBackground(env).changed, true); }
    finally { process.kill = originalKill; }
    assert.equal(existsSync(dashboardPidPath(env)), false);
    assert.equal(existsSync(vault), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('dashboard lifecycle cleans up a stale PID file', () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-dashboard-stale-'));
  const env = { HIPPO_CORE_HOME: home };
  try {
    writeFileSync(dashboardPidPath(env), '99999999\n');
    assert.equal(dashboardStatus(env).running, false);
    assert.equal(existsSync(dashboardPidPath(env)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
