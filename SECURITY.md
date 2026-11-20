# Security

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately on GitHub instead:
[**Security → Report a vulnerability**](https://github.com/kiosko-lcd/kiosko/security/advisories/new)
in this repository, or in the repository of the plugin it affects
(`kiosko-lcd/kiosko-plugin-*`, each has the same button).

Say what is affected (Kiosko's version, the plugin and its version), how to
reproduce it and what an attacker gains. The advisory is published with
the fix.

## What is supported

The latest release of Kiosko (npm `kiosko`, the Windows installer) and of
each official plugin. Fixes are not backported.

## Worth knowing

- **Plugins run with your user's rights.** What a plugin declares
  (`permissions`: hosts, programs, files) is shown before you install it,
  but it is a promise, not a fence. Install plugins you trust.
- **The editor listens on 127.0.0.1** by default, and its API only accepts
  changes that carry the `X-Kiosko` header (no cross-site forms). Exposing
  it with `--host` to a network hands that network the editor.
- **Configs from elsewhere** (one an AI wrote, someone else's): `kiosko
  config import <file>` lists every value that runs a program, contacts a
  host or reads a path before applying it.
