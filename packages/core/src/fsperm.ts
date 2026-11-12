import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { userInfo } from 'node:os';

/**
 * Makes `path` readable by its owner only: mode 0600, or, on Windows (where
 * `chmod` can't do it), an ACL without inheritance that grants just the
 * current user. Best effort: a file system without permissions (FAT, some
 * network shares) just keeps what it has.
 */
export function restrictToOwner(path: string, os: NodeJS.Platform = process.platform): void {
  try {
    if (os !== 'win32') {
      chmodSync(path, 0o600);
      return;
    }
    const user = process.env.USERNAME || userInfo().username;
    const domain = process.env.USERDOMAIN;
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${domain ? `${domain}\\` : ''}${user}:F`], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
  } catch {
    /* best effort */
  }
}
