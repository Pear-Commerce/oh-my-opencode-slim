/**
 * Loop Guard — detects repeated tool-call patterns and breaks the cycle.
 *
 * Models (DeepSeek, GLM, Kimi, Gemini Flash, etc.) can get stuck in
 * "doom loops" where they repeat the same tool calls dozens of times
 * without progressing. OpenCode's built-in doom_loop permission asks the
 * user — but with `permission: "allow"` (common for autonomous/headless
 * use), it auto-approves and the loop continues indefinitely.
 *
 * This hook operates at the tool-output level, independent of permissions:
 * - After a fingerprint appears 3 times in the recent window: append a nudge
 * - After a fingerprint appears 5 times in the recent window: REPLACE the
 *   tool output with an interrupt, withholding the repeated content so the
 *   model's input changes and the byte-identical input→output cycle breaks
 *
 * Uses a sliding window of recent fingerprints per session. This catches
 * both consecutive duplicates (A→A→A) and multi-call cycles (A→B→A→B→A→B)
 * that a simple "consecutive identical" detector would miss.
 *
 * Read-after-edit is safe: a read with different args (different offset,
 * different file) produces a different fingerprint and dilutes the window.
 */

// --- Thresholds ---

/** Append a nudge to the tool output (real content still delivered). */
const WARN_THRESHOLD = 3;

/** Replace the tool output entirely, withholding the repeated content. */
const HARD_THRESHOLD = 5;

/**
 * Sliding window size. Must be large enough to catch multi-call cycles.
 * With HARD_THRESHOLD=5 and a 2-cycle (A→B→A→B→...), A reaches threshold
 * at 5 occurrences = 10 calls. Window of 20 comfortably covers 2-cycles
 * and 3-cycles while staying small enough for O(n) per-call cost.
 */
const WINDOW_SIZE = 20;

const LOOP_NUDGE_MARKER = '[LOOP DETECTED — STOP REPEATING THIS CALL]';
const LOOP_INTERRUPT_MARKER = '[LOOP INTERRUPT — repeated identical call suppressed]';

// --- State ---

interface WindowEntry {
  fingerprint: string;
  description: string;
}

interface LoopState {
  /** Sliding window of recent fingerprints (most recent at end). */
  window: WindowEntry[];
}

interface PendingHit {
  fingerprint: string;
  count: number;
  description: string;
}

const bySession = new Map<string, LoopState>();
const pending = new Map<string, PendingHit>();

// --- Fingerprinting ---

/**
 * Produce a stable string from tool name + args.
 * Object keys are sorted so {a:1,b:2} and {b:2,a:1} produce the same fingerprint.
 */
function fingerprint(tool: string, args: unknown): string {
  const toolKey = tool.toLowerCase();
  const argsKey = stableStringify(args);
  return `${toolKey}:${argsKey}`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Build a short human-readable description of the tool call for nudge text.
 * Shows the tool name and key args (filePath, offset, limit, command, etc).
 */
function describeCall(tool: string, args: unknown): string {
  const toolName = tool.toLowerCase();
  if (typeof args !== 'object' || args === null) {
    return `\`${toolName}\``;
  }
  const obj = args as Record<string, unknown>;
  const parts: string[] = [`\`${toolName}\``];

  const filePath = obj.filePath ?? obj.path ?? obj.file_path;
  if (typeof filePath === 'string') parts.push(`filePath=${filePath}`);

  const offset = obj.offset ?? obj.start_line ?? obj.line;
  if (offset !== undefined) parts.push(`offset=${offset}`);

  const limit = obj.limit ?? obj.count ?? obj.end_line;
  if (limit !== undefined) parts.push(`limit=${limit}`);

  const command = obj.command ?? obj.cmd;
  if (typeof command === 'string') {
    parts.push(`command=${command.slice(0, 80)}`);
  }

  const pattern = obj.pattern ?? obj.regex;
  if (typeof pattern === 'string') {
    parts.push(`pattern=${pattern.slice(0, 80)}`);
  }

  return parts.join(', ');
}

// --- Nudge / interrupt text ---

function nudgeText(count: number, description: string): string {
  return `\n\n${LOOP_NUDGE_MARKER}
You have issued this exact ${description} ${count} times recently.
The result is identical every time and is already in your context. Repeating it changes nothing.
Do NOT issue this call again. Choose ONE:
  1. Act on what you already have (edit / write / run a different command).
  2. Inspect a DIFFERENT file, location, or pattern.
  3. If you are blocked, state the blocker plainly and return your final answer.`;
}

function interruptText(count: number, description: string): string {
  return `${LOOP_INTERRUPT_MARKER}
This is the ${count}th occurrence of ${description}. The content is UNCHANGED from the
copies already in your context, so it has been withheld to break the loop you are stuck in.
You are repeating the same actions without making progress. Change strategy NOW:
  - Take a concrete action based on what you have already seen, OR
  - Explain what is blocking you and return your final answer.
Do not repeat this call — you will keep getting this message, not the result.`;
}

// --- Hook types ---

interface ToolExecuteBeforeInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolExecuteBeforeOutput {
  args?: unknown;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolExecuteAfterOutput {
  output?: unknown;
}

// --- Hook factory ---

export function createLoopGuardHook() {
  return {
    'tool.execute.before': async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      const { sessionID, callID } = input;
      if (!sessionID || !callID) return;

      const fp = fingerprint(input.tool, output.args);
      const desc = describeCall(input.tool, output.args);
      let state = bySession.get(sessionID);
      if (!state) {
        state = { window: [] };
        bySession.set(sessionID, state);
      }

      // Push into sliding window, cap at WINDOW_SIZE
      state.window.push({ fingerprint: fp, description: desc });
      if (state.window.length > WINDOW_SIZE) {
        state.window.shift();
      }

      // Count occurrences of this fingerprint in the window
      const count = state.window.filter(
        (entry) => entry.fingerprint === fp,
      ).length;

      if (count >= WARN_THRESHOLD) {
        pending.set(callID, { fingerprint: fp, count, description: desc });
      }
    },

    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const { callID } = input;
      if (!callID) return;

      const hit = pending.get(callID);
      if (!hit) return;
      pending.delete(callID);

      if (typeof output.output !== 'string') return;

      // Idempotency: don't double-inject
      if (output.output.includes(LOOP_NUDGE_MARKER)) return;
      if (output.output.includes(LOOP_INTERRUPT_MARKER)) return;

      if (hit.count >= HARD_THRESHOLD) {
        // Replace — withhold the repeated content to break the cycle
        output.output = interruptText(hit.count, hit.description);
      } else {
        // Append — nudge the model but still deliver the content
        output.output += nudgeText(hit.count, hit.description);
      }
    },
  };
}

// --- Cleanup ---

/** Clear loop state for a session. Called on session.deleted. */
export function clearLoopState(sessionID: string): void {
  bySession.delete(sessionID);
}

// --- Test helpers (exported for unit tests) ---

export const _internals = {
  WARN_THRESHOLD,
  HARD_THRESHOLD,
  WINDOW_SIZE,
  LOOP_NUDGE_MARKER,
  LOOP_INTERRUPT_MARKER,
  fingerprint,
  stableStringify,
  describeCall,
  nudgeText,
  interruptText,
  bySession,
  pending,
  reset: (): void => {
    bySession.clear();
    pending.clear();
  },
};
