# @loksly/agent-sessions

A tiny file protocol for the state of your AI coding sessions (Claude Code,
Gemini CLI, …), so that anything can show which session needs you: an LCD
panel, a status bar, a tmux segment, a microcontroller on your desk.

- **A hook** (`agent-sessions-hook`) that your CLI calls on every event. It
  writes one JSON file per session, atomically, with no dependencies and no
  network. It never fails loudly: it exits 0 whatever happens.
- **A protocol**: the record format, versioned, with a
  [JSON Schema](schema/session-record.schema.json) for clients in any language.
- **Helpers to read it**: list sessions, order them by urgency, reap dead
  ones, and optionally enrich them with git data.

## The record

`~/.aimonitor/sessions/<session_id>.json` (see *Where files live* below):

```json
{
  "schemaVersion": 1,
  "session_id": "7377b6e2-…",
  "provider": "claude",
  "state": "permission",
  "detail": "Bash: npm publish",
  "project": "my-repo",
  "cwd": "/home/me/my-repo",
  "since": 1791662627994,
  "updated": 1791662627994,
  "event": "Notification"
}
```

`state`, from most to least urgent:

| State | Meaning |
|---|---|
| `permission` | Blocked on a permission prompt. |
| `waiting` | Idle, waiting for your input. |
| `ready` | Finished its turn. |
| `active` | Working. |
| `idle` | Just started or resumed. |

`since` is when it entered that state, so a client can show *how long it has
been waiting*. Optional fields carry signals for richer clients: `files`
touched, `lastFailed`/`failStreak` for shell commands, `testsFailed`, `todos`
added, `talkStreak`/`duck` (turns spent talking without tools), `compactAt`.
Secrets in `detail` (tokens, `Authorization` headers, credentials in URLs) are
redacted before writing.

## Wiring the hook

```sh
npm install -g @loksly/agent-sessions
```

**Claude Code**, in `~/.claude/settings.json` (one entry per event you want):

```json
{
  "hooks": {
    "SessionStart":       [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "PreToolUse":         [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "PostToolUse":        [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "Notification":       [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "Stop":               [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "PreCompact":         [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }],
    "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "agent-sessions-hook", "timeout": 5 }] }]
  }
}
```

**Gemini CLI**: the same command with `--provider gemini`.

## Reading it

```ts
import { readSessions, order, reap, claims } from '@loksly/agent-sessions';

const live = reap(readSessions(), Date.now(), { zombieMs: 15 * 60_000, staleMs: 2 * 3600_000 });
for (const s of order(live)) console.log(claims(s) ? '!' : ' ', s.state, s.project, s.detail);
```

With git data (repository root, HEAD, uncommitted files):

```ts
import { createGitEnricher } from '@loksly/agent-sessions/git';
const enrich = createGitEnricher();
const rich = await Promise.all(live.map(enrich)); // adds repo, dirty, dirtyFiles, detached, lastCommit…
```

From any other language, read the JSON files and validate them against
`schema/session-record.schema.json` (also exported as
`@loksly/agent-sessions/schema.json`).

## Where files live

`$AGENT_SESSIONS_DIR`, or `sessions/` inside `$AIMONITOR_DIR`
(default `~/.aimonitor`).

## Adding a CLI

Each CLI sends its own JSON on stdin. `src/providers.ts` turns it into a
canonical event; adding a provider means an adapter there plus its payloads
replayed through the conformance story in `src/hook.test.ts`. The state
machine does not change.

## Contributing

This package lives in the [aimonitor](https://github.com/Loksly/aimonitor)
repository under `packages/agent-sessions`, whose dashboard for Thermalright
LCD panels is its first client. Issues and pull requests are welcome there.
Run `npm test` from the package directory.

## License

MIT
