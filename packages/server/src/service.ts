/**
 * `kiosko service install|uninstall|print`: start Kiosko with the session,
 * the native way on each OS.
 *
 *   Linux    systemd user unit  ~/.config/systemd/user/kiosko.service
 *   macOS    LaunchAgent        ~/Library/LaunchAgents/dev.kiosko.plist
 *   Windows  Scheduled task "Kiosko" at logon (schtasks) running a hidden
 *            launcher, %APPDATA%\Kiosko\kiosko-start.vbs; log in kiosko.log
 *
 * The command line is built from the running Node and CLI paths, so it keeps
 * working with nvm, Homebrew or a portable Node.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kioskoHome } from '@kiosko/core';

export interface ServicePlan {
  kind: 'systemd' | 'launchd' | 'schtasks';
  file?: string;
  content: string;
  /** Write `file` as UTF-16 with a BOM (what Windows Script Host reads without guessing the code page). */
  utf16?: boolean;
  enable: string[][];
  disable: string[][];
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function servicePlan(o: { node?: string; cli?: string; args?: string[]; env?: Record<string, string>; os?: NodeJS.Platform; home?: string } = {}): ServicePlan {
  const node = o.node ?? process.execPath;
  const cli = o.cli ?? resolve(process.argv[1] ?? fileURLToPath(import.meta.url));
  // Running from source needs the `source` condition; the bundle doesn't care.
  const nodeArgs = cli.endsWith('.ts') ? ['--conditions=source'] : [];
  const args = [...nodeArgs, cli, 'start', ...(o.args ?? [])];
  const os = o.os ?? platform();
  // Services don't read your shell profile: give them a PATH where plugins
  // find the CLIs they call (glab, ccusage, docker, trcc…) and node itself.
  const sep = os === 'win32' ? ';' : ':';
  const path = [dirname(node), join(homedir(), '.local', 'bin'), ...(os === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin', '/usr/bin', '/bin'].join(sep);
  const env = { ...(os === 'win32' ? {} : { PATH: path }), ...(o.env ?? {}) };
  if (os === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', 'dev.kiosko.plist');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.kiosko</string>
  <key>ProgramArguments</key>
  <array>
${[node, ...args].map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(homedir(), 'Library', 'Logs', 'kiosko.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(homedir(), 'Library', 'Logs', 'kiosko.log'))}</string>
</dict>
</plist>
`;
    return { kind: 'launchd', file, content, enable: [['launchctl', 'load', '-w', file]], disable: [['launchctl', 'unload', '-w', file]] };
  }
  if (os === 'win32') {
    // A task that runs `node.exe` shows a console window for as long as Kiosko
    // lives. A tiny VBScript starts it hidden instead (window style 0) and
    // appends its output to a log, which also stands in for the journal.
    const home = o.home ?? kioskoHome();
    const file = win32.join(home, 'kiosko-start.vbs');
    const log = win32.join(home, 'kiosko.log');
    const q = (a: string) => `"${a}"`;
    const inner = `${[node, ...args].map(q).join(' ')} >> ${q(log)} 2>&1`;
    const vbs = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const content = `' Starts Kiosko without a console window. Written by \`kiosko service install\`.\r\nCreateObject("WScript.Shell").Run ${vbs(`cmd.exe /d /s /c "${inner}"`)}, 0, False\r\n`;
    const tr = `wscript.exe //B //Nologo "${file}"`;
    return {
      kind: 'schtasks',
      file,
      content,
      utf16: true,
      enable: [['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'Kiosko', '/TR', tr], ['schtasks', '/Run', '/TN', 'Kiosko']],
      // `schtasks /End` stops the launcher but leaves node.exe (and the cmd.exe
      // that holds the log open) running: end them by their command line.
      disable: [['schtasks', '/End', '/TN', 'Kiosko'], stopProcesses(cli), ['schtasks', '/Delete', '/F', '/TN', 'Kiosko']],
    };
  }
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', 'kiosko.service');
  const q = (a: string) => (/[\s"\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a);
  const content = `[Unit]
Description=Kiosko: widgets for USB LCD panels
After=network-online.target

[Service]
Type=simple
ExecStart=${[node, ...args].map(q).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment=${k}=${q(v)}`).join('\n')}
# Logs go to the journal: journalctl --user -u kiosko
Restart=always
RestartSec=5
# Painting is cheap but bursty; keep it from competing with your work.
Nice=10

[Install]
WantedBy=default.target
`;
  return { kind: 'systemd', file, content, enable: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'kiosko.service']], disable: [['systemctl', '--user', 'disable', '--now', 'kiosko.service']] };
}

/**
 * PowerShell that ends the node.exe / cmd.exe processes running this CLI
 * (Windows), except this very process: `kiosko service uninstall` runs the
 * same cli.js and must live to delete the task afterwards.
 */
function stopProcesses(cli: string): string[] {
  const like = cli.replace(/'/g, "''").replace(/[[\]`*?]/g, '`$&');
  const script = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'cmd.exe') -and $_.CommandLine -like '*${like}*' -and $_.ProcessId -ne $PID -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return ['powershell', '-NoProfile', '-NonInteractive', '-Command', script];
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
      writeFileSync(plan.file, plan.utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plan.content, 'utf16le')]) : plan.content);
      console.log(`written ${plan.file}`);
    }
    for (const c of plan.enable) execFileSync(c[0]!, c.slice(1), { stdio: 'inherit' });
    console.log('Kiosko will start with your session. Editor: http://127.0.0.1:7420/');
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
  console.log('usage: kiosko service install|uninstall|print');
}
