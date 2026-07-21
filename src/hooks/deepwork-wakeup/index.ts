/**
 * Deepwork wakeup hook — event-driven + periodic "/loop" equivalent.
 *
 * When a managed orchestrator delegates background work and goes idle, and a
 * background job later completes, the completion is injected into the
 * orchestrator's message stream — but only manifests on the NEXT API call.
 * If nothing re-triggers the idle orchestrator, it never sees the completion,
 * never reconciles, and the deepwork loop dies.
 *
 * This hook provides two wake mechanisms:
 *
 * **Event-driven wakes** (background completion → wake):
 * 1. Background session idle — a delegated task completed. If its parent
 *    orchestrator is managed and idle, wake the parent via promptAsync.
 * 2. Orchestrator idle with unreconciled work — the board already knows about
 *    unreconciled terminal jobs. Wake it to retry reconciliation.
 *
 * **Periodic done-check interval** (true /loop — handles premature idle with
 * empty board):
 * 3. When a managed orchestrator that has EVER had background work goes idle,
 *    start a periodic timer. Every `intervalMs`, if the orchestrator is still
 *    idle, send a one-word done-check: "Look carefully — are you done with
 *    all planned work? Respond with one word: yes or no."
 *    - If the orchestrator responds "no" (not done) → reprompt to keep working.
 *    - If the orchestrator responds "yes" (done) → stop the timer.
 *    - If there is unreconciled background work when "yes" is received, override
 *      to "no" (there is pending work to reconcile).
 *
 * Termination: the periodic timer stops when:
 * - The orchestrator session is deleted.
 * - The orchestrator confirms "yes, done" (with no unreconciled work).
 * - Safety cap exceeded: too many consecutive "no" answers without any board
 *   progress (the orchestrator is stuck saying "not done" but not advancing).
 *
 * Safety: the periodic timer only starts for sessions that have had
 * background work (deepwork is active). Regular chat sessions are not
 * affected. A dedup window prevents rapid re-waking.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../utils/logger';
import type { BackgroundJobBoard } from '../../utils/background-job-board';

const DEFAULT_DEDUP_WINDOW_MS = 3_000;
const DEFAULT_WAKE_DELAY_MS = 800;
const DEFAULT_INTERVAL_MS = 5_000; // 5 seconds — check frequently, no-op when busy
const DEFAULT_MAX_NO_PROGRESS = 15; // safety cap on consecutive "no" without progress
const MESSAGE_READ_DELAY_MS = 500; // let OpenCode write the response before reading
const DEFAULT_GATE_TIMEOUT_MS = 600_000; // 10 min for gate execution (LLM reviews can be slow)
const GATE_FAIL_COOLDOWN_MS = 120_000; // 2 min cooldown after gate FAIL before re-firing

const GATE_DIR_NAME = '.slim/deepwork/gates';

/**
 * Persist a gate to disk so it survives process restarts.
 * Written to <directory>/.slim/deepwork/gates/<sessionID>.json
 */
function persistGate(directory: string | undefined, sessionID: string, gate: LoopGate | undefined): void {
  if (!directory) return;
  try {
    const gateDir = join(directory, GATE_DIR_NAME);
    mkdirSync(gateDir, { recursive: true });
    const gateFile = join(gateDir, `${sessionID}.json`);
    if (gate === undefined) {
      if (existsSync(gateFile)) unlinkSync(gateFile);
      return;
    }
    writeFileSync(gateFile, JSON.stringify(gate, null, 2));
  } catch (err) {
    log('[deepwork-wakeup] failed to persist gate', {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Load a persisted gate from disk. Called when a managed session is first
 * seen after a process restart, to restore gate state.
 */
function loadPersistedGate(directory: string | undefined, sessionID: string): LoopGate | undefined {
  if (!directory) return undefined;
  try {
    const gateFile = join(directory, GATE_DIR_NAME, `${sessionID}.json`);
    if (!existsSync(gateFile)) return undefined;
    const content = readFileSync(gateFile, 'utf-8');
    const gate = JSON.parse(content) as LoopGate;
    log('[deepwork-wakeup] loaded persisted gate from disk', {
      sessionID,
      gateType: gate.type,
    });
    return gate;
  } catch (err) {
    log('[deepwork-wakeup] failed to load persisted gate', {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

const EVENT_WAKEUP_MESSAGE =
  'Background work is ready to reconcile. Review the Background Job Board and continue: reconcile terminal results, validate, and proceed to the next phase or finish if all work is complete.';

const DONE_CHECK_MESSAGE =
  'Have you completed all work in the current deepwork scope, with any remaining work explicitly deferred and documented? Respond with one word: yes or no.';

const CONTINUE_MESSAGE =
  'Continue your deepwork. Pick up where you left off and proceed with the next unfinished task.';

const GATE_FAIL_MESSAGE =
  'The convergence gate failed. Review the gate output above, fix the issues, and continue.';

/**
 * Loop gate — replaces the model yes/no done-check with a machine-checkable
 * termination condition for convergence loops ("get this passable according
 * to x standard").
 *
 * - `command`: run a shell command. Exit 0 = pass (stop), non-zero = fail (continue).
 * - `adjudicator`: the hook sends the orchestrator a prescriptive gate-check
 *   prompt that makes it spawn an Oracle subagent via the `task` tool with the
 *   gate prompt. The Oracle subagent is visible in the desktop TUI (clickable,
 *   followable — same UX as any task-spawned subagent) so the user can verify
 *   it hasn't stalled. The orchestrator reports the Oracle's PASS/FAIL verdict
 *   back; the hook parses it and stops the loop on PASS or sends a continue
 *   prompt on FAIL. `model` is accepted for backward compatibility but ignored
 *   — the Oracle runs on its configured model. `files` are passed as paths in
 *   the gate prompt for the Oracle to read.
 *
 * When no gate is set, the hook uses the model yes/no done-check (checklist
 * mode). When a gate is set, it uses the gate (convergence mode).
 */
export type LoopGate =
  | { type: 'command'; command: string; timeoutMs?: number }
  | {
      type: 'adjudicator';
      prompt: string;
      model?: string;
      timeoutMs?: number;
      files?: string[];
    };

interface SessionWakeState {
  idle: boolean;
  lastWakeAt: number;
  awaitingDoneCheck: boolean;
  consecutiveNoProgress: number;
  lastBoardSignature: string;
  wakeInFlight: boolean;
  gate?: LoopGate;
  lastGateFailAt: number;
  lastBackgroundActivityAt: number;
  /**
   * True only after the adjudicator gate-check prompt has been successfully
   * sent to the orchestrator (not just requested). Prevents the idle handler
   * from calling handleGateCheckResponse on a stale message when a duplicate
   * idle event fires between runGate setting awaitingDoneCheck=true and
   * sendGateCheck actually sending the prompt.
   */
  gateCheckPromptSent: boolean;
}

export interface DeepworkWakeupOptions {
  backgroundJobBoard: BackgroundJobBoard;
  shouldManageSession: (sessionID: string) => boolean;
  wakeDelayMs?: number;
  dedupWindowMs?: number;
  /** Periodic wakeup interval in ms (default 120000 = 2 min). */
  intervalMs?: number;
  /** Safety cap: max consecutive "no" answers without board progress. */
  maxNoProgress?: number;
  /** Delay before reading done-check response in ms (default 500). */
  messageReadDelayMs?: number;
  /** Project directory for command gate execution. */
  directory?: string;
  /** Poll interval for adjudicator response in ms (default 3000). */
  pollIntervalMs?: number;
  /**
   * Whether the periodic done-check / gate timer is enabled. Defaults to
   * true (the original behavior): startTimer() fires an interval that asks
   * the idle orchestrator "are you done?" and re-prompts it to continue when
   * it says "no".
   *
   * Set to false to disable the periodic poll. After a manual abort (user
   * stops the thread), OpenCode emits only session.idle — no abort event —
   * so the hook cannot distinguish "stopped by user" from "finished a turn",
   * and the periodic check re-executes the thread the user just stopped.
   * Disabling keeps event-driven wakes (background completion → reconcile)
   * and one-shot gate firing from the idle handler; only the periodic poll
   * is gone.
   */
  periodicDoneCheck?: boolean;
  /**
   * Resolve the model and agent for a session, so promptAsync uses the
   * session's configured model instead of falling back to the default
   * agent's model. Returns { providerID, modelID, agent? } or undefined.
   * May be async (e.g. to query the session's messages when the in-memory
   * map is empty after a restart).
   */
  resolveModel?: (
    sessionID: string,
  ) =>
    | { providerID: string; modelID: string; agent?: string }
    | undefined
    | Promise<{ providerID: string; modelID: string; agent?: string } | undefined>;
  /**
   * Resolve the oracle specialist agent name for a given orchestrator agent
   * name. Custom orchestrators with a `specialists` override get a scoped
   * oracle subagent registered as `oracle__<orchestratorName>` (with the
   * overridden model, e.g. gpt-5.6-sol); other orchestrators use the
   * generic `oracle`. The hook uses this to put the correct subagent_type
   * in the adjudicator gate-check prompt so the oracle runs on the right
   * model (not the default oracle model). Falls back to 'oracle' if not
   * provided or the orchestrator is unknown.
   */
  resolveOracleSpecialistName?: (orchestratorAgentName: string) => string;
}

export function createDeepworkWakeupHook(
  client: PluginInput['client'],
  options: DeepworkWakeupOptions,
) {
  const { backgroundJobBoard, shouldManageSession, directory, resolveModel, resolveOracleSpecialistName } =
    options;
  const dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const wakeDelayMs = options.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxNoProgress = options.maxNoProgress ?? DEFAULT_MAX_NO_PROGRESS;
  const messageReadDelayMs = options.messageReadDelayMs ?? MESSAGE_READ_DELAY_MS;
  const periodicDoneCheck = options.periodicDoneCheck ?? true;

  const states = new Map<string, SessionWakeState>();
  const hasHadBackgroundWork = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  const sessionsSeen = new Set<string>();

  function getState(sessionID: string): SessionWakeState {
    let s = states.get(sessionID);
    if (!s) {
      s = {
        idle: false,
        lastWakeAt: 0,
        awaitingDoneCheck: false,
        consecutiveNoProgress: 0,
        lastBoardSignature: '',
        wakeInFlight: false,
        lastGateFailAt: 0,
        lastBackgroundActivityAt: 0,
        gateCheckPromptSent: false,
      };
      states.set(sessionID, s);
    }
    return s;
  }

  function boardSignature(sessionID: string): string {
    return backgroundJobBoard
      .list(sessionID)
      .map((j) => `${j.taskID}:${j.state}:${j.terminalUnreconciled}`)
      .join('|');
  }

  function isIdleEvent(event: {
    type: string;
    properties?: { status?: { type?: string } };
  }): boolean {
    if (event.type === 'session.idle') return true;
    if (
      event.type === 'session.status' &&
      event.properties?.status?.type === 'idle'
    )
      return true;
    return false;
  }

  function isBusyEvent(event: {
    type: string;
    properties?: { status?: { type?: string } };
  }): boolean {
    return (
      event.type === 'session.status' &&
      event.properties?.status?.type === 'busy'
    );
  }

  function clearTimer(sessionID: string): void {
    const timer = timers.get(sessionID);
    if (timer) {
      clearInterval(timer);
      timers.delete(sessionID);
      log('[deepwork-wakeup] periodic timer cleared', { sessionID });
    }
  }

  function startTimer(sessionID: string): void {
    if (!periodicDoneCheck) return; // disabled via option — see DeepworkWakeupOptions
    if (timers.has(sessionID)) return; // already running

    const timer = setInterval(() => {
      const state = states.get(sessionID);
      if (!state) {
        clearTimer(sessionID);
        return;
      }
      if (!state.idle) return; // orchestrator is busy, skip this tick
      if (state.awaitingDoneCheck) return; // already sent a done-check, waiting for response
      if (state.wakeInFlight) return; // a wake is in progress

      // Safety cap: too many "no" answers without board progress
      if (state.consecutiveNoProgress >= maxNoProgress) {
        log('[deepwork-wakeup] max no-progress done-checks reached, stopping', {
          sessionID,
          consecutiveNoProgress: state.consecutiveNoProgress,
        });
        clearTimer(sessionID);
        return;
      }

      // Don't fire the done-check/gate while background jobs are still
      // running OR while there's unreconciled terminal work. The
      // orchestrator is correctly idle waiting for them — the event-driven
      // wake (Case 2) handles completion. Firing the gate here would start
      // a new review while a fixer result is still pending reconciliation.
      if (
        backgroundJobBoard.hasRunning(sessionID) ||
        backgroundJobBoard.hasTerminalUnreconciled(sessionID)
      ) {
        return;
      }

      log('[deepwork-wakeup] periodic timer firing gate/done-check', {
        sessionID,
        hasGate: Boolean(state.gate),
      });
      sendDoneCheck(sessionID).catch(() => {});
    }, intervalMs);

    // Do NOT unref this timer. The plugin runs in a Node.js utility process
    // inside Electron. When the orchestrator goes idle and there's no other
    // I/O, an unref'd timer won't fire because the event loop has nothing
    // else to process. The timer must stay ref'd so it actually fires.
    // Cleanup is handled by session.deleted events and _destroy().

    timers.set(sessionID, timer);
    log('[deepwork-wakeup] periodic timer started', {
      sessionID,
      intervalMs,
    });
  }

  /**
   * Send a promptAsync to an idle managed orchestrator.
   * Returns true if sent, false if blocked by guards.
   */
  async function sendPrompt(
    sessionID: string,
    message: string,
    reason: string,
  ): Promise<boolean> {
    const state = getState(sessionID);
    if (!state.idle) return false;
    if (state.wakeInFlight) return false;

    const now = Date.now();
    if (now - state.lastWakeAt < dedupWindowMs) return false;

    state.wakeInFlight = true;
    state.lastWakeAt = now;

    // Wrap the ENTIRE body in try/finally so wakeInFlight is ALWAYS reset,
    // even on early returns (e.g. orchestrator became busy during the wake
    // delay). Previously the finally was inside the inner try block, so an
    // early return before that block left wakeInFlight stuck true forever.
    try {
      if (wakeDelayMs > 0) {
        await new Promise((r) => setTimeout(r, wakeDelayMs));
      }

      // Re-check idle AFTER the delay. The orchestrator may have become busy
      // during the delay (user message, background completion, etc.). Sending
      // a prompt to a busy session interrupts active work.
      if (!state.idle) {
        log('[deepwork-wakeup] orchestrator became busy during wake delay, aborting', {
          sessionID,
          reason,
        });
        return false;
      }

      const sessionClient = client.session as unknown as {
        promptAsync?: (args: {
          path: { id: string };
          body: {
            parts: Array<{ type: 'text'; text: string }>;
            model?: { providerID: string; modelID: string };
            agent?: string;
          };
        }) => Promise<unknown>;
      };

      if (typeof sessionClient.promptAsync !== 'function') {
        log('[deepwork-wakeup] promptAsync unavailable', { sessionID });
        return false;
      }

      // Resolve the session's model so promptAsync uses the session's
      // configured model (e.g. glm-5.2) instead of falling back to the
      // default agent's model (e.g. gpt-5.5). Without this, every wakeup
      // call burns the wrong model's credits.
      const model = await resolveModel?.(sessionID);

      // Race promptAsync against a 10s timeout. If promptAsync hangs (server
      // not responding, network issue), the timeout fires, wakeInFlight is
      // reset in the finally block, and the hook isn't permanently blocked.
      const PROMPT_ASYNC_TIMEOUT_MS = 10_000;
      await Promise.race([
        sessionClient.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [{ type: 'text', text: message }],
            ...(model ? { model, ...(model.agent ? { agent: model.agent } : {}) } : {}),
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('promptAsync timed out')),
            PROMPT_ASYNC_TIMEOUT_MS,
          ),
        ),
      ]);

      // The prompt will make the orchestrator busy. Set idle=false now to
      // prevent the periodic timer from firing again before the busy event
      // arrives.
      state.idle = false;

      log('[deepwork-wakeup] woke orchestrator', {
        sessionID,
        reason,
      });
      return true;
    } catch (err) {
      log('[deepwork-wakeup] wake failed', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      state.wakeInFlight = false;
    }
  }

  /**
   * Send the one-word done-check question.
   */
  async function sendDoneCheck(sessionID: string): Promise<void> {
    const state = getState(sessionID);

    // If a gate is configured, run it instead of the model yes/no check.
    if (state.gate) {
      await runGate(sessionID, state.gate);
      return;
    }

    const sent = await sendPrompt(sessionID, DONE_CHECK_MESSAGE, 'done-check');
    if (sent) {
      state.awaitingDoneCheck = true;
    }
  }

  /**
   * Run a convergence gate.
   *
   * - `command`: run synchronously, act on pass/fail immediately.
   * - `adjudicator`: send a prescriptive gate-check prompt to the orchestrator
   *   (fire-and-forget). The orchestrator delegates to the Oracle via the
   *   `task` tool (desktop-visible subagent) and reports back GATE: PASS/FAIL.
   *   The verdict is parsed when the orchestrator goes idle again — see
   *   `handleGateCheckResponse`. `awaitingDoneCheck` stays true until then.
   */
  async function runGate(sessionID: string, gate: LoopGate): Promise<void> {
    const state = getState(sessionID);
    state.awaitingDoneCheck = true; // prevent timer from firing again
    state.gateCheckPromptSent = false; // reset — set true when sendGateCheck succeeds

    try {
      if (gate.type === 'adjudicator') {
        const sent = await sendGateCheck(sessionID, gate);
        if (!sent) {
          // sendPrompt didn't fire (orchestrator not idle / wake in flight) —
          // release the lock so the next idle can retry.
          state.awaitingDoneCheck = false;
        }
        return;
      }

      // Command gate: run synchronously and act on pass/fail immediately.
      const result = runCommandGate(gate);
      let passed = result.passed;
      let output = result.output;

      log('[deepwork-wakeup] gate executed', {
        sessionID,
        gateType: gate.type,
        passed,
        outputPreview: output.slice(0, 200),
      });

      // Override pass if there is unreconciled background work
      if (passed && backgroundJobBoard.hasTerminalUnreconciled(sessionID)) {
        log('[deepwork-wakeup] gate passed but unreconciled work remains, continuing', {
          sessionID,
        });
        passed = false;
        output = 'Gate passed, but unreconciled background work remains.';
      }

      if (passed) {
        log('[deepwork-wakeup] gate passed, stopping periodic timer', {
          sessionID,
        });
        clearTimer(sessionID);
        // Clear the persisted gate — the loop is done.
        persistGate(directory, sessionID, undefined);
        return;
      }

      // Gate failed — send continue with the gate output.
      const message = `${GATE_FAIL_MESSAGE}\n\n## Gate output\n\`\`\`\n${output}\n\`\`\``;
      state.lastGateFailAt = Date.now();
      await sendPrompt(sessionID, message, 'gate-fail-continue');

      // Track progress for safety cap
      const sig = boardSignature(sessionID);
      if (sig === state.lastBoardSignature) {
        state.consecutiveNoProgress += 1;
      } else {
        state.consecutiveNoProgress = 0;
        state.lastBoardSignature = sig;
      }
    } catch (err) {
      log('[deepwork-wakeup] gate execution failed', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      // On gate error, send continue (safer to keep working than to stop)
      await sendPrompt(
        sessionID,
        `${GATE_FAIL_MESSAGE}\n\n## Gate error\nThe gate could not be executed: ${err instanceof Error ? err.message : String(err)}`,
        'gate-error-continue',
      );
    } finally {
      // Command gates ran synchronously — release the lock. Adjudicator
      // gates keep awaitingDoneCheck=true until the orchestrator responds
      // (handleGateCheckResponse resets it).
      if (gate.type === 'command') {
        state.awaitingDoneCheck = false;
      }
    }
  }

  /**
   * Run a command gate. Exit 0 = pass, non-zero = fail.
   */
  function runCommandGate(gate: {
    command: string;
    timeoutMs?: number;
  }): { passed: boolean; output: string } {
    const timeoutMs = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    try {
      const output = execSync(gate.command, {
        cwd: directory ?? process.cwd(),
        encoding: 'utf-8',
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { passed: true, output: output.trim() || '(no output)' };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output = [e.stdout ?? '', e.stderr ?? '', e.message ?? '']
        .filter(Boolean)
        .join('\n')
        .trim();
      return { passed: false, output: output || '(no output)' };
    }
  }

  /**
   * Send the adjudicator gate-check prompt to the orchestrator.
   *
   * The orchestrator is instructed to delegate to its Oracle specialist via
   * the `task` tool (foreground) and report the Oracle's PASS/FAIL verdict
   * back as "GATE: PASS" or "GATE: FAIL" on its first line. The Oracle
   * subagent is a normal task-tool session, so the desktop renders it as a
   * clickable, followable subagent — the user can watch it live and verify
   * it hasn't stalled, just like any other subagent.
   *
   * The oracle specialist name is resolved via `resolveOracleSpecialistName`
   * so custom orchestrators with a `specialists` override route to their
   * scoped oracle (e.g. `oracle__orchestrator-glm52-sol`, which runs on the
   * overridden model) instead of the generic `oracle` (which runs on the
   * default oracle model). Falls back to 'oracle' if the resolver is not
   * provided or the orchestrator is unknown.
   *
   * `files` are passed as paths in the prompt for the Oracle to read (the
   * Oracle has read_files permission). `model` is intentionally not used —
   * the Oracle runs on its configured model.
   *
   * Returns true if the prompt was sent, false if sendPrompt suppressed it
   * (orchestrator not idle / wake in flight).
   */
  async function sendGateCheck(
    sessionID: string,
    gate: { prompt: string; files?: string[] },
  ): Promise<boolean> {
    // Resolve the orchestrator's agent name so we can look up its scoped
    // oracle specialist (if any). resolveModel returns the wakeup model
    // (glm-5p2) but also the session's agent name, which is what we need.
    let oracleName = 'oracle';
    try {
      const model = await resolveModel?.(sessionID);
      const agentName = model?.agent;
      if (agentName && resolveOracleSpecialistName) {
        const resolved = resolveOracleSpecialistName(agentName);
        if (resolved) oracleName = resolved;
      }
    } catch (err) {
      log('[deepwork-wakeup] failed to resolve oracle specialist name, using generic', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const fileNote =
      gate.files && gate.files.length > 0
        ? `\n\nThe Oracle should read these files as part of its review: ${gate.files.join(', ')}`
        : '';

    const message = [
      'A convergence gate is already set and running — you are NOT being asked to set, configure, or clear any gate. Do not call set_loop_gate. You are being asked to RUN one gate check: delegate to your Oracle specialist and report its verdict.',
      '',
      'Step 1: Call the task tool with subagent_type "' + oracleName + '" (foreground, not background) and this prompt:',
      '```',
      gate.prompt,
      '```' + fileNote,
      '',
      'Step 2: After the Oracle responds, your ENTIRE reply must be:',
      '- Line 1: exactly "GATE: PASS" or "GATE: FAIL" (matching the Oracle\'s verdict — nothing else on this line)',
      '- Line 2 (optional): a brief one-line summary of the issue (if FAIL)',
      '',
      'Do NOT repeat the Oracle\'s full response — it is visible in the Oracle subagent and already in your context from the task tool output. Do NOT add any preface, commentary, or explanation before the "GATE: PASS" / "GATE: FAIL" line. Your first line must be the verdict and only the verdict.',
    ].join('\n');

    const sent = await sendPrompt(sessionID, message, 'gate-check');
    if (sent) {
      getState(sessionID).gateCheckPromptSent = true;
      log('[deepwork-wakeup] gate-check prompt sent to orchestrator', {
        sessionID,
        oracleSpecialist: oracleName,
        fileCount: gate.files?.length ?? 0,
      });
    }
    return sent;
  }

  /**
   * Read the orchestrator's last assistant message (the gate-check reply).
   * Returns the text, or null if unreadable/empty.
   */
  async function readGateCheckResponse(
    sessionID: string,
  ): Promise<string | null> {
    try {
      if (messageReadDelayMs > 0) {
        await new Promise((r) => setTimeout(r, messageReadDelayMs));
      }

      const result = await client.session.messages({
        path: { id: sessionID },
      });
      const messages = (result.data ?? []) as Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }>;

      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.info.role === 'assistant');
      if (!lastAssistant) return null;

      const text = lastAssistant.parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text ?? '')
        .join(' ')
        .trim();

      return text || null;
    } catch (err) {
      log('[deepwork-wakeup] failed to read gate-check response', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Handle the orchestrator's gate-check response.
   * Called when the orchestrator goes idle after a gate-check was sent.
   *
   * Parses "GATE: PASS" / "GATE: FAIL" (or a leading PASS/FAIL) from the
   * orchestrator's reply. PASS → stop the loop. FAIL → send a continue
   * prompt with the gate output. Ambiguous → default to FAIL (keep working).
   */
  async function handleGateCheckResponse(sessionID: string): Promise<void> {
    const state = getState(sessionID);
    // Keep awaitingDoneCheck=true during response handling so the periodic
    // timer doesn't fire another gate-check while we're reading + deciding.
    // gateCheckPromptSent is reset here so the next gate-check cycle starts
    // clean (runGate will set it to false, sendGateCheck sets it true again).

    const text = await readGateCheckResponse(sessionID);

    if (!text) {
      // Couldn't read response — retry on next interval
      state.awaitingDoneCheck = false;
      state.gateCheckPromptSent = false;
      log('[deepwork-wakeup] gate-check response unreadable, will retry', {
        sessionID,
      });
      return;
    }

    const lower = text.toLowerCase();
    const firstLine = lower.split('\n')[0] ?? '';
    const passed = /gate:\s*pass\b/.test(lower) || /^\s*pass\b/.test(firstLine);
    const failed = /gate:\s*fail\b/.test(lower) || /^\s*fail\b/.test(firstLine);

    log('[deepwork-wakeup] gate-check response parsed', {
      sessionID,
      passed,
      failed,
      responsePreview: text.slice(0, 200),
    });

    // Ambiguous (neither matched, or both matched) — default to fail.
    if (!passed && !failed) {
      log('[deepwork-wakeup] gate-check response ambiguous, defaulting to fail', {
        responsePreview: text.slice(0, 100),
      });
      state.awaitingDoneCheck = false;
      state.gateCheckPromptSent = false;
      state.lastGateFailAt = Date.now();
      await sendPrompt(
        sessionID,
        `${GATE_FAIL_MESSAGE}\n\n## Gate output\nThe gate-check response was ambiguous (no "GATE: PASS" or "GATE: FAIL" found on the first line). Re-run the gate check: delegate to the Oracle via the task tool and reply with "GATE: PASS" or "GATE: FAIL" on the first line. Do NOT repeat the Oracle's full response — just the verdict on line 1.`,
        'gate-ambiguous-continue',
      );
      return;
    }

    // If both matched, prefer fail (keep working) — safer.
    const verdictPass = passed && !failed;

    // Override pass if there is unreconciled background work
    if (verdictPass && backgroundJobBoard.hasTerminalUnreconciled(sessionID)) {
      log('[deepwork-wakeup] gate passed but unreconciled work remains, continuing', {
        sessionID,
      });
      state.awaitingDoneCheck = false;
      state.gateCheckPromptSent = false;
      state.lastGateFailAt = Date.now();
      await sendPrompt(
        sessionID,
        `${GATE_FAIL_MESSAGE}\n\n## Gate output\nGate passed, but unreconciled background work remains. Reconcile the pending work and continue.`,
        'gate-pass-override',
      );
      return;
    }

    if (verdictPass) {
      log('[deepwork-wakeup] gate passed, stopping periodic timer', {
        sessionID,
      });
      clearTimer(sessionID);
      state.awaitingDoneCheck = false;
      state.gateCheckPromptSent = false;
      // Clear the persisted gate — the loop is done.
      persistGate(directory, sessionID, undefined);
      return;
    }

    // verdict === fail — send continue. The orchestrator already has the
    // Oracle's full response in its context (from the task tool output), and
    // the user can click the Oracle subagent to see it. Don't dump the full
    // text — just the verdict line + brief summary (first 2 lines max).
    const firstTwoLines = text.split('\n').slice(0, 2).join('\n');
    const message = `${GATE_FAIL_MESSAGE}\n\n## Gate verdict\n\`\`\`\n${firstTwoLines}\n\`\`\`\n\nReview the Oracle's full feedback in the task tool output above and fix the issues.`;
    state.awaitingDoneCheck = false;
    state.gateCheckPromptSent = false;
    state.lastGateFailAt = Date.now();
    await sendPrompt(sessionID, message, 'gate-fail-continue');

    // Track progress for safety cap
    const sig = boardSignature(sessionID);
    if (sig === state.lastBoardSignature) {
      state.consecutiveNoProgress += 1;
    } else {
      state.consecutiveNoProgress = 0;
      state.lastBoardSignature = sig;
    }
  }

  /**
   * Read the last assistant message from a session and parse yes/no.
   * Returns 'yes', 'no', or null (ambiguous/unreadable).
   */
  async function readDoneCheckResponse(
    sessionID: string,
  ): Promise<'yes' | 'no' | null> {
    try {
      // Small delay to ensure the response is fully written
      if (messageReadDelayMs > 0) {
        await new Promise((r) => setTimeout(r, messageReadDelayMs));
      }

      const result = await client.session.messages({
        path: { id: sessionID },
      });
      const messages = (result.data ?? []) as Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }>;

      // Find the last assistant message
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.info.role === 'assistant');
      if (!lastAssistant) return null;

      // Extract text from parts
      const text = lastAssistant.parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text ?? '')
        .join(' ')
        .trim()
        .toLowerCase();

      if (!text) return null;

      // Parse one-word response: check if it starts with yes or no
      if (/^\s*yes\b/.test(text)) return 'yes';
      if (/^\s*no\b/.test(text)) return 'no';

      // Fallback: check if "yes" or "no" appears anywhere
      if (/\byes\b/.test(text) && !/\bno\b/.test(text)) return 'yes';
      if (/\bno\b/.test(text) && !/\byes\b/.test(text)) return 'no';

      // Ambiguous — default to "no" (keep working) to avoid premature stop
      log('[deepwork-wakeup] ambiguous done-check response, defaulting to no', {
        sessionID,
        responsePreview: text.slice(0, 100),
      });
      return 'no';
    } catch (err) {
      log('[deepwork-wakeup] failed to read done-check response', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Handle the orchestrator's done-check response.
   * Called when the orchestrator goes idle after a done-check was sent.
   */
  async function handleDoneCheckResponse(sessionID: string): Promise<void> {
    const state = getState(sessionID);
    // Keep awaitingDoneCheck=true during response handling so the periodic
    // timer doesn't fire another done-check while we're reading + deciding.

    const answer = await readDoneCheckResponse(sessionID);

    if (answer === null) {
      // Couldn't read response — retry on next interval
      state.awaitingDoneCheck = false;
      log('[deepwork-wakeup] done-check response unreadable, will retry', {
        sessionID,
      });
      return;
    }

    // Override "yes" if there is unreconciled background work
    if (answer === 'yes' && backgroundJobBoard.hasTerminalUnreconciled(sessionID)) {
      log('[deepwork-wakeup] orchestrator said yes but unreconciled work remains, continuing', {
        sessionID,
      });
      await sendPrompt(sessionID, CONTINUE_MESSAGE, 'done-check-yes-override');
      state.awaitingDoneCheck = false;
      return;
    }

    if (answer === 'yes') {
      log('[deepwork-wakeup] orchestrator confirmed done, stopping periodic timer', {
        sessionID,
      });
      clearTimer(sessionID);
      state.awaitingDoneCheck = false;
      return;
    }

    // answer === 'no' — reprompt to keep working
    // Track board progress for safety cap
    const sig = boardSignature(sessionID);
    if (sig === state.lastBoardSignature) {
      state.consecutiveNoProgress += 1;
    } else {
      state.consecutiveNoProgress = 0;
      state.lastBoardSignature = sig;
    }

    await sendPrompt(sessionID, CONTINUE_MESSAGE, 'done-check-no-continue');
    state.awaitingDoneCheck = false;
  }

  return {
    event: async (input: {
      event: {
        type: string;
        properties?: {
          info?: { id?: string };
          sessionID?: string;
          status?: { type?: string };
        };
      };
    }): Promise<void> => {
      const event = input.event;
      const sessionId =
        event.properties?.info?.id ?? event.properties?.sessionID;

      if (!sessionId) return;

      // Clean up on session deletion
      if (event.type === 'session.deleted') {
        clearTimer(sessionId);
        states.delete(sessionId);
        hasHadBackgroundWork.delete(sessionId);
        sessionsSeen.delete(sessionId);
        persistGate(directory, sessionId, undefined); // remove persisted gate
        return;
      }

      // Busy: clear idle state. Also clear the background-activity cooldown —
      // the orchestrator going busy means it's processing something (likely
      // the background result we woke it for). When it goes idle again, the
      // gate can fire instantly instead of waiting for the 2-min cooldown.
      // The cooldown only matters if the orchestrator DOESN'T go busy (stays
      // idle without processing), which is exactly when we want to wait.
      if (isBusyEvent(event)) {
        if (shouldManageSession(sessionId)) {
          const state = getState(sessionId);
          state.idle = false;
          state.lastBackgroundActivityAt = 0;
        }
        return;
      }

      if (!isIdleEvent(event)) return;

      // Case 1: managed orchestrator went idle.
      if (shouldManageSession(sessionId)) {
        const state = getState(sessionId);
        state.idle = true;

        // If this is the first time we've seen this session (after a
        // process restart), try to reload any persisted gate from disk.
        // The gate is in-memory and resets on restart — without this, the
        // orchestrator falls back to checklist mode and loses its
        // convergence loop.
        if (!state.gate && !sessionsSeen.has(sessionId)) {
          const persisted = loadPersistedGate(directory, sessionId);
          if (persisted) {
            state.gate = persisted;
          }
        }
        sessionsSeen.add(sessionId);

        // If we were awaiting a done-check, handle the response now.
        // BUT: if a gate is set, awaitingDoneCheck means a gate-check is in
        // flight — the orchestrator was sent the gate-check prompt and is
        // expected to reply with "GATE: PASS" or "GATE: FAIL" after
        // delegating to the Oracle via the task tool. Calling
        // handleDoneCheckResponse here would misread that reply as a yes/no
        // answer, send a checklist continue prompt, and create an infinite
        // wake loop. Instead, route gate-check replies to
        // handleGateCheckResponse.
        if (state.awaitingDoneCheck && !state.gate) {
          await handleDoneCheckResponse(sessionId);
          // After handling, the timer is either cleared (yes) or still running (no).
          // If "no", a continue prompt was sent — orchestrator will go busy.
          // Don't start a new timer; the existing one is still running.
          return;
        }

        // A gate-check is in flight (awaitingDoneCheck + gate). But only
        // handle the response if the gate-check prompt was actually sent
        // (gateCheckPromptSent=true). If a duplicate idle event fires
        // between runGate setting awaitingDoneCheck=true and sendGateCheck
        // sending the prompt, gateCheckPromptSent is still false — skip,
        // the first idle event's sendGateCheck is still in flight.
        if (state.awaitingDoneCheck && state.gate) {
          if (!state.gateCheckPromptSent) {
            log('[deepwork-wakeup] idle: gate-check prompt not yet sent, skipping', {
              sessionID: sessionId,
            });
            return;
          }
          log('[deepwork-wakeup] idle: handling gate-check response', {
            sessionID: sessionId,
          });
          await handleGateCheckResponse(sessionId);
          return;
        }

        // Mark as having had background work if the board has any jobs
        if (backgroundJobBoard.list(sessionId).length > 0) {
          hasHadBackgroundWork.add(sessionId);
        }

        // If the board already knows about unreconciled work, wake now
        // (event-driven, not done-check)
        let sentEventWake = false;
        if (backgroundJobBoard.hasTerminalUnreconciled(sessionId)) {
          hasHadBackgroundWork.add(sessionId);
          sentEventWake = await sendPrompt(
            sessionId,
            EVENT_WAKEUP_MESSAGE,
            'orchestrator-idle-with-unreconciled',
          );
        }

        // Start periodic timer if this session has had background work
        // OR has a gate set (convergence loop — the gate is the signal).
        if (hasHadBackgroundWork.has(sessionId) || state.gate) {
          startTimer(sessionId);
        }

        // If a gate is set and no background jobs are running, fire the gate
        // directly from the idle handler. Don't rely solely on the periodic
        // timer — if the timer is stuck or not firing, this ensures the gate
        // runs immediately when the orchestrator goes idle.
        // BUT: don't fire if there's unreconciled terminal work OR if we just
        // sent an event wake to process a reconciled result — the orchestrator
        // needs to process the result first. Firing the gate here would start
        // a new deck review while the fixer result is still being processed.
        if (state.gate) {
          const hasRunning = backgroundJobBoard.hasRunning(sessionId);
          const hasUnreconciled = backgroundJobBoard.hasTerminalUnreconciled(sessionId);
          // Cooldown: don't fire the gate if it recently FAILed OR if there
          // was recent background activity. Both give the orchestrator time
          // to act before the gate re-fires. Without the background-activity
          // cooldown, the gate fires right after a background job is
          // reconciled but before the orchestrator processes the result.
          const now = Date.now();
          const gateFailCooldown =
            state.lastGateFailAt > 0
              ? Math.max(0, GATE_FAIL_COOLDOWN_MS - (now - state.lastGateFailAt))
              : 0;
          const bgActivityCooldown =
            state.lastBackgroundActivityAt > 0
              ? Math.max(0, GATE_FAIL_COOLDOWN_MS - (now - state.lastBackgroundActivityAt))
              : 0;
          const cooldownRemaining = Math.max(gateFailCooldown, bgActivityCooldown);
          log('[deepwork-wakeup] idle: gate-fire guard check', {
            sessionID: sessionId,
            gate: true,
            awaitingDoneCheck: state.awaitingDoneCheck,
            wakeInFlight: state.wakeInFlight,
            sentEventWake,
            hasRunning,
            hasUnreconciled,
            cooldownRemainingMs: cooldownRemaining,
          });
          if (
            !state.awaitingDoneCheck &&
            !state.wakeInFlight &&
            !sentEventWake &&
            !hasRunning &&
            !hasUnreconciled &&
            cooldownRemaining === 0
          ) {
            log('[deepwork-wakeup] firing gate directly from idle handler', {
              sessionID: sessionId,
              gateType: state.gate.type,
            });
            sendDoneCheck(sessionId).catch(() => {});
          }
        }

        return;
      }

      // Case 2: non-managed (background) session went idle.
      // A delegated task completed. Find its parent and wake the parent if
      // the parent is a managed orchestrator that is currently idle.
      const job = backgroundJobBoard.get(sessionId);
      if (!job) return;
      if (job.state === 'reconciled') return;

      const parentID = job.parentSessionID;
      if (!shouldManageSession(parentID)) return;

      hasHadBackgroundWork.add(parentID);

      const parentState = getState(parentID);
      // Record background activity so the gate cooldown knows to wait for
      // the orchestrator to process this result before re-firing.
      parentState.lastBackgroundActivityAt = Date.now();
      if (!parentState.idle) return;
      if (parentState.awaitingDoneCheck) return; // done-check in progress, don't interfere

      await sendPrompt(parentID, EVENT_WAKEUP_MESSAGE, `background-idle:${sessionId}`);
    },

    /**
     * Set a convergence gate for a session. When set, the periodic timer
     * runs the gate instead of the model yes/no done-check.
     * Call with undefined to clear the gate and revert to checklist mode.
     *
     * Setting a gate also starts the periodic timer immediately if the
     * session is currently idle — the gate itself is the signal that this
     * is a convergence loop, so we don't require prior background work.
     */
    setGate(sessionID: string, gate: LoopGate | undefined): void {
      const state = getState(sessionID);
      state.gate = gate;
      log('[deepwork-wakeup] gate set', {
        sessionID,
        gateType: gate?.type,
      });

      // Persist to disk so the gate survives process restarts.
      persistGate(directory, sessionID, gate);

      // Setting a gate is itself the signal that this is a convergence loop.
      // Start the periodic timer immediately if the session is idle, even
      // without prior background work.
      if (gate && state.idle && !timers.has(sessionID)) {
        startTimer(sessionID);
      }
    },

    /** @internal Exposed for testing */
    _states: states,
    _timers: timers,
    _hasHadBackgroundWork: hasHadBackgroundWork,

    /** @internal Clean up all timers (for testing / plugin teardown) */
    _destroy(): void {
      for (const id of timers.keys()) {
        clearTimer(id);
      }
    },
  };
}
