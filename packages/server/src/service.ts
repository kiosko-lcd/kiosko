/**
 * `tessera service install|uninstall|print`: start Tessera with the session,
 * the native way on each OS.
 *
 *   Linux    systemd user unit  ~/.config/systemd/user/tessera.service
 *   macOS    LaunchAgent        ~/Library/LaunchAgents/dev.tessera.plist
 *   Windows  Scheduled task "Tessera" at logon (schtasks), hidden window
 *
 * The command line is built from the running Node and CLI paths, so it keeps
 * working with nvm, Homebrew or a portable Node.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServicePlan {
  kind: 'systemd' | 'launchd' | 'schtasks';
  file?: string;
  content: string;
  enable: string[][];
  disable: string[][];
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function servicePlan(o: { node?: string; cli?: string; args?: string[]; env?: Record<string, string>; os?: NodeJS.Platform } = {}): ServicePlan {
  const node = o.node ?? process.execPath;
  const cli = o.cli ?? resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  // Running from source needs the `source` condition; the bundle doesn't care.
  const nodeArgs = cli.endsWith('.ts') ? ['--conditions=source'] : [];
  const args = [...nodeArgs, cli, 'start', ...(o.args ?? [])];
  const env = o.env ?? {};
  const os = o.os ?? platform();
  if (os === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', 'dev.tessera.plist');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.tessera</string>
  <key>ProgramArguments</key>
  <array>
${[node, ...args].map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TESSERA_QUIET</key><string>1</string>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xml(join(homedir(), 'Library', 'Logs', 'tessera.log'))}</string>
</dict>
</plist>
`;
    return { kind: 'launchd', file, content, enable: [['launchctl', 'load', '-w', file]], disable: [['launchctl', 'unload', '-w', file]] };
  }
  if (os === 'win32') {
    const cmd = [node, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    return {
      kind: 'schtasks',
      content: cmd,
      enable: [['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'Tessera', '/TR', cmd], ['schtasks', '/Run', '/TN', 'Tessera']],
      disable: [['schtasks', '/End', '/TN', 'Tessera'], ['schtasks', '/Delete', '/F', '/TN', 'Tessera']],
    };
  }
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', 'tessera.service');
  const q = (a: string) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a);
  const content = `[Unit]
Description=Tessera: widgets for USB LCD panels
After=network-online.target

[Service]
Type=simple
ExecStart=${[node, ...args].map(q).join(' ')}
Environment=TESSERA_QUIET=1
${Object.entries(env).map(([k, v]) => `Environment=${k}=${q(v)}`).join('\n')}
Restart=on-failure
RestartSec=5
# Painting is cheap but bursty; keep it from competing with your work.
Nice=10

[Install]
WantedBy=default.target
`;
  return { kind: 'systemd', file, content, enable: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'tessera.service']], disable: [['systemctl', '--user', 'disable', '--now', 'tessera.service']] };
}

export function runService(action: string, plan: ServicePlan): void {
  if (action === 'print') {
    if (plan.file) console.log(`# ${plan.file}`);
    console.log(plan.content);
    for (const c of plan.enable) console.log(`$ ${c.join(' ')}`);
    return;
  }
  if (action === 'install') {
    if (plan.file) {
      mkdirSync(dirname(plan.file), { recursive: true });
      writeFileSync(plan.file, plan.content);
      console.log(`written ${plan.file}`);
    }
    for (const c of plan.enable) execFileSync(c[0]!, c.slice(1), { stdio: 'inherit' });
    console.log('Tessera will start with your session. Editor: http://127.0.0.1:7420/');
    return;
  }
  if (action === 'uninstall') {
    for (const c of plan.disable) {
      try {
        execFileSync(c[0]!, c.slice(1), { stdio: 'inherit' });
      } catch {
        /* already gone */
      }
    }
    if (plan.file && existsSync(plan.file)) rmSync(plan.file);
    console.log('removed');
    return;
  }
  console.log('usage: tessera service install|uninstall|print');
}
