import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { VERSION } from '../config.js';

function command() {
  return `npx -y @hippo-core/core@${VERSION} dashboard --foreground`;
}

export function dashboardAutostartSpec(options = {}) {
  const home = options.home || homedir();
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const appData = options.appData || join(home, 'AppData', 'Roaming');
    return {
      platform,
      path: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'hippo-core-dashboard.cmd'),
      content: `@echo off\r\nstart "Hippo Core Dashboard" /min ${command()}\r\n`,
    };
  }
  if (platform === 'darwin') {
    return {
      platform,
      path: join(home, 'Library', 'LaunchAgents', 'io.hippocore.dashboard.plist'),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.hippocore.dashboard</string>
<key>ProgramArguments</key><array><string>/usr/bin/env</string><string>sh</string><string>-lc</string><string>${command()}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
`,
    };
  }
  return {
    platform,
    path: join(home, '.config', 'autostart', 'hippo-core-dashboard.desktop'),
    content: `[Desktop Entry]\nType=Application\nName=Hippo Core Dashboard\nExec=sh -lc '${command()}'\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`,
  };
}

export function installDashboardAutostart(options = {}) {
  const spec = dashboardAutostartSpec(options);
  const changed = !existsSync(spec.path);
  if (!options.dryRun) {
    mkdirSync(dirname(spec.path), { recursive: true });
    writeFileSync(spec.path, spec.content, { mode: 0o600 });
  }
  return { ...spec, changed };
}

export function uninstallDashboardAutostart(options = {}) {
  const spec = dashboardAutostartSpec(options);
  const changed = existsSync(spec.path);
  if (!options.dryRun) rmSync(spec.path, { force: true });
  return { ...spec, changed };
}
