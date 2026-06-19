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
import { log } from '../../utils/logger';
import type { BackgroundJobBoard } from '../../utils/background-job-board';

const DEFAULT_DEDUP_WINDOW_MS = 3_000;
const DEFAULT_WAKE_DELAY_MS = 800;
const DEFAULT_INTERVAL_MS = 120_000; // 2 minutes
const DEFAULT_MAX_NO_PROGRESS = 15; // safety cap on consecutive "no" without progress
const MESSAGE_READ_DELAY_MS = 500; // let OpenCode write the response before reading

const EVENT_WAKEUP_MESSAGE =
  'Background work is ready to reconcile. Review the Background Job Board and continue: reconcile terminal results, validate, and proceed to the next phase or finish if all work is complete.';

const DONE_CHECK_MESSAGE =
  'Look carefully at your deepwork progress file and current state. Are you done with all planned work? Respond with one word: yes or no.';

const CONTINUE_MESSAGE =
  'Continue your deepwork. Pick up where you left off and proceed with the next unfinished task.';

interface SessionWakeState {
  idle: boolean;
  lastWakeAt: number;
  awaitingDoneCheck: boolean;
  consecutiveNoProgress: number;
  lastBoardSignature: string;
  wakeInFlight: boolean;
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
}

export function createDeepworkWakeupHook(
  client: PluginInput['client'],
  options: DeepworkWakeupOptions,
) {
  const { backgroundJobBoard, shouldManageSession } = options;
  const dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const wakeDelayMs = options.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxNoProgress = options.maxNoProgress ?? DEFAULT_MAX_NO_PROGRESS;
  const messageReadDelayMs = options.messageReadDelayMs ?? MESSAGE_READ_DELAY_MS;

  const states = new Map<string, SessionWakeState>();
  const hasHadBackgroundWork = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();

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

      sendDoneCheck(sessionID).catch(() => {});
    }, intervalMs);

    // Don't keep the process alive solely for this timer
    timer.unref?.();

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

    if (wakeDelayMs > 0) {
      await new Promise((r) => setTimeout(r, wakeDelayMs));
    }

    try {
      const sessionClient = client.session as unknown as {
        promptAsync?: (args: {
          path: { id: string };
          body: {
            parts: Array<{ type: 'text'; text: string }>;
          };
        }) => Promise<unknown>;
      };

      if (typeof sessionClient.promptAsync !== 'function') {
        log('[deepwork-wakeup] promptAsync unavailable', { sessionID });
        return false;
      }

      await sessionClient.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text: message }],
        },
      });

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
    const sent = await sendPrompt(sessionID, DONE_CHECK_MESSAGE, 'done-check');
    if (sent) {
      state.awaitingDoneCheck = true;
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
    state.awaitingDoneCheck = false;

    const answer = await readDoneCheckResponse(sessionID);

    if (answer === null) {
      // Couldn't read response — retry on next interval
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
      return;
    }

    if (answer === 'yes') {
      log('[deepwork-wakeup] orchestrator confirmed done, stopping periodic timer', {
        sessionID,
      });
      clearTimer(sessionID);
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
        return;
      }

      // Busy: clear idle state
      if (isBusyEvent(event)) {
        if (shouldManageSession(sessionId)) {
          const state = getState(sessionId);
          state.idle = false;
        }
        return;
      }

      if (!isIdleEvent(event)) return;

      // Case 1: managed orchestrator went idle.
      if (shouldManageSession(sessionId)) {
        const state = getState(sessionId);
        state.idle = true;

        // If we were awaiting a done-check, handle the response now
        if (state.awaitingDoneCheck) {
          await handleDoneCheckResponse(sessionId);
          // After handling, the timer is either cleared (yes) or still running (no).
          // If "no", a continue prompt was sent — orchestrator will go busy.
          // Don't start a new timer; the existing one is still running.
          return;
        }

        // Mark as having had background work if the board has any jobs
        if (backgroundJobBoard.list(sessionId).length > 0) {
          hasHadBackgroundWork.add(sessionId);
        }

        // If the board already knows about unreconciled work, wake now
        // (event-driven, not done-check)
        if (backgroundJobBoard.hasTerminalUnreconciled(sessionId)) {
          hasHadBackgroundWork.add(sessionId);
          await sendPrompt(
            sessionId,
            EVENT_WAKEUP_MESSAGE,
            'orchestrator-idle-with-unreconciled',
          );
        }

        // Start periodic timer if this session has had background work
        if (hasHadBackgroundWork.has(sessionId)) {
          startTimer(sessionId);
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
      if (!parentState.idle) return;
      if (parentState.awaitingDoneCheck) return; // done-check in progress, don't interfere

      await sendPrompt(parentID, EVENT_WAKEUP_MESSAGE, `background-idle:${sessionId}`);
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
