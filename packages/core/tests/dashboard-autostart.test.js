import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardAutostartSpec, installDashboardAutostart, uninstallDashboardAutostart } from '../src/dashboard/autostart.js';

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`dashboard autostart is installable and reversible on ${platform}`, () => {
    const home = mkdtempSync(join(tmpdir(), `hippo-autostart-${platform}-`));
    try {
      const spec = dashboardAutostartSpec({ home, platform, appData: join(home, 'AppData') });
      const installed = installDashboardAutostart({ home, platform, appData: join(home, 'AppData') });
      assert.equal(installed.changed, true);
      assert.ok(existsSync(spec.path));
      assert.match(readFileSync(spec.path, 'utf8'), /@hippo-core\/core@1\.3\.0/);
      assert.equal(installDashboardAutostart({ home, platform, appData: join(home, 'AppData') }).changed, false);
      assert.equal(uninstallDashboardAutostart({ home, platform, appData: join(home, 'AppData') }).changed, true);
      assert.equal(existsSync(spec.path), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
