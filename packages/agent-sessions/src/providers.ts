/**
 * Provider adapters: how to read an event from each CLI's hook payload.
 *
 * Every CLI sends a JSON object on stdin, but field names differ. An adapter
 * turns that object into a `HookEvent` with canonical names (Claude Code's
 * event names: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, Notification, Stop, SubagentStop, PreCompact,
 * SessionEnd). Adding a CLI means adding an adapter here, with its fixtures
 * in the tests; the state machine in hook.ts does not change.
 */
import type { KnownProvider } from './protocol.ts';

export interface HookEvent {
  /** Canonical event name ('' if absent). */
  event: string;
  sessionId: string;
  cwd: string;
  tool: string;
  toolInput: unknown;
  toolResponse: unknown;
  /** Why a session started: startup, resume, compact, clear… */
  source: string;
  /** Notification kind or message. */
  notification: string;
  prompt: string;
  /** The assistant's last message, on Stop. */
  lastMessage: string;
  /** Free text for events this package does not know. */
  fallback: string;
}

export interface ProviderAdapter {
  name: string;
  normalize(data: Record<string, any>, cwd: string): HookEvent;
}

/** Event names that differ from Claude Code's, per provider. */
const ALIASES: Record<string, Record<string, string>> = {};

/**
 * The field names Claude Code uses, with the alternatives Gemini CLI and
 * hand-written scripts have been seen to send.
 */
function generic(provider: string) {
  return (data: Record<string, any>, cwd: string): HookEvent => {
    const raw: string = data.hook_event_name || data.event || data.type || '';
    return {
      event: ALIASES[provider]?.[raw] ?? raw,
      sessionId: data.session_id || data.sessionId || 'global',
      cwd: data.cwd || cwd,
      tool: String(data.tool_name ?? data.tool?.name ?? data.tool ?? ''),
      toolInput: data.tool_input ?? data.tool?.arguments,
      toolResponse: data.tool_response,
      source: String(data.source ?? data.session_start_type ?? ''),
      notification: String(data.notification_type ?? data.notificationType ?? data.message ?? ''),
      prompt: String(data.prompt ?? ''),
      lastMessage: String(data.last_assistant_message ?? ''),
      fallback: String(data.detail ?? data.message ?? data.command ?? ''),
    };
  };
}

export const PROVIDERS: Readonly<Record<KnownProvider, ProviderAdapter>> = {
  claude: { name: 'claude', normalize: generic('claude') },
  gemini: { name: 'gemini', normalize: generic('gemini') },
};

/** The adapter for a provider name; unknown names read the generic field names. */
export function adapterFor(name: string): ProviderAdapter {
  return (PROVIDERS as Record<string, ProviderAdapter>)[name] ?? { name, normalize: generic(name) };
}
