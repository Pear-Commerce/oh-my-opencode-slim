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
 * **Periodic wakeup interval** (true /loop — handles premature idle with
 * empty board):
 * 3. When a managed orchestrator that has EVER had background work goes idle,
 *    start a periodic timer. Every `intervalMs`, if the orchestrator is still
 *    idle, wake it to check for remaining work. This catches the case where
 *    the orchestrator stops mid-work without any background jobs in flight
 *    (no event to trigger a wake).
 *
 * Termination: the periodic timer stops when:
 * - The orchestrator session is deleted.
 * - Max consecutive no-op wakes exceeded (the orchestrator keeps going idle
 *   within seconds of being woken, without doing real work or changing the
 *   board — it's truly done or stuck).
 *
 * Progress detection: wakeCount resets when EITHER the board signature
 * changes (new background activity) OR the orchestrator was busy for > 5s
 * after a wake (did real foreground work). Only quick no-op responses
 * increment the counter.
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
const DEFAULT_MAX_WAKES_WITHOUT_PROGRESS = 8;
const DEFAULT_INTERVAL_MS = 120_000; // 2 minutes
const NO_OP_THRESHOLD_MS = 5_000; // busy < 5s after wake = no-op

const EVENT_WAKEUP_MESSAGE =
  'Background work is ready to reconcile. Review the Background Job Board and continue: reconcile terminal results, validate, and proceed to the next phase or finish if all work is complete.';

const PERIODIC_WAKEUP_MESSAGE =
  'Periodic wakeup: check if there is remaining deepwork to continue. If you have unfinished phases, deferred work, or uncommitted changes, proceed. If all work is complete and validated, say so and stop.';

interface SessionWakeState {
  idle: boolean;
  lastWakeAt: number;
  lastBusyAt: number;
  wakeCount: number;
  lastBoardSignature: string;
  wakeInFlight: boolean;
}

export interface DeepworkWakeupOptions {
  backgroundJobBoard: BackgroundJobBoard;
  shouldManageSession: (sessionID: string) => boolean;
  wakeDelayMs?: number;
  dedupWindowMs?: number;
  maxWakesWithoutProgress?: number;
  /** Periodic wakeup interval in ms (default 120000 = 2 min). */
  intervalMs?: number;
}

export function createDeepworkWakeupHook(
  client: PluginInput['client'],
  options: DeepworkWakeupOptions,
) {
  const { backgroundJobBoard, shouldManageSession } = options;
  const dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const wakeDelayMs = options.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS;
  const maxWakes =
    options.maxWakesWithoutProgress ?? DEFAULT_MAX_WAKES_WITHOUT_PROGRESS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  const states = new Map<string, SessionWakeState>();
  const hasHadBackgroundWork = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  function getState(sessionID: string): SessionWakeState {
    let s = states.get(sessionID);
    if (!s) {
      s = {
        idle: false,
        lastWakeAt: 0,
        lastBusyAt: 0,
        wakeCount: 0,
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

      // Check if we've exceeded max no-op wakes
      if (state.wakeCount >= maxWakes) {
        log('[deepwork-wakeup] max no-op wakes reached, stopping periodic timer', {
          sessionID,
          wakeCount: state.wakeCount,
        });
        clearTimer(sessionID);
        return;
      }

      wake(sessionID, 'periodic-interval').catch(() => {});
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
   * Wake an idle managed orchestrator via promptAsync.
   * Guards: dedup window, max-wakes-without-progress, in-flight.
   */
  async function wake(sessionID: string, reason: string): Promise<void> {
    const state = getState(sessionID);
    if (!state.idle) return;
    if (state.wakeInFlight) return;

    const now = Date.now();
    if (now - state.lastWakeAt < dedupWindowMs) return;

    // Safety: stop waking if the board hasn't changed between wakes.
    const sig = boardSignature(sessionID);
    if (sig === state.lastBoardSignature) {
      state.wakeCount += 1;
      if (state.wakeCount >= maxWakes) {
        log('[deepwork-wakeup] max wakes without progress, stopping', {
          sessionID,
          reason,
          wakeCount: state.wakeCount,
        });
        clearTimer(sessionID);
        return;
      }
    } else {
      state.wakeCount = 0;
      state.lastBoardSignature = sig;
    }

    state.wakeInFlight = true;
    state.lastWakeAt = now;

    // Let OpenCode settle the idle state and write completion data before
    // we trigger the API call that will read it.
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
        return;
      }

      const message = reason.startsWith('periodic')
        ? PERIODIC_WAKEUP_MESSAGE
        : EVENT_WAKEUP_MESSAGE;

      await sessionClient.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text: message }],
        },
      });

      log('[deepwork-wakeup] woke orchestrator', {
        sessionID,
        reason,
        wakeCount: state.wakeCount,
      });
    } catch (err) {
      log('[deepwork-wakeup] wake failed', {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      state.wakeInFlight = false;
    }
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

      // Busy: record timestamp, clear idle state
      if (isBusyEvent(event)) {
        if (shouldManageSession(sessionId)) {
          const state = getState(sessionId);
          state.idle = false;
          state.lastBusyAt = Date.now();
        }
        return;
      }

      if (!isIdleEvent(event)) return;

      // Case 1: managed orchestrator went idle.
      if (shouldManageSession(sessionId)) {
        const state = getState(sessionId);
        const now = Date.now();
        state.idle = true;

        // Progress detection: if the orchestrator was busy for > 5s after
        // a wake, it did real foreground work — reset wakeCount even if the
        // board signature didn't change.
        if (
          state.lastWakeAt > 0 &&
          state.lastBusyAt > state.lastWakeAt &&
          now - state.lastBusyAt > NO_OP_THRESHOLD_MS
        ) {
          if (state.wakeCount > 0) {
            log('[deepwork-wakeup] foreground progress detected, resetting wakeCount', {
              sessionID: sessionId,
              busyDurationMs: now - state.lastBusyAt,
              previousWakeCount: state.wakeCount,
            });
            state.wakeCount = 0;
          }
        }

        // Mark as having had background work if the board has any jobs
        if (backgroundJobBoard.list(sessionId).length > 0) {
          hasHadBackgroundWork.add(sessionId);
        }

        // If the board already knows about unreconciled work, wake now.
        if (backgroundJobBoard.hasTerminalUnreconciled(sessionId)) {
          hasHadBackgroundWork.add(sessionId);
          await wake(sessionId, 'orchestrator-idle-with-unreconciled');
        }

        // Start periodic timer if this session has had background work
        // (deepwork is active). This catches premature idle with empty board.
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
      if (job.state === 'reconciled') return; // already fully processed

      const parentID = job.parentSessionID;
      if (!shouldManageSession(parentID)) return;

      // Mark parent as having had background work
      hasHadBackgroundWork.add(parentID);

      const parentState = getState(parentID);
      if (!parentState.idle) return;

      // The background session going idle IS the signal that work is ready,
      // even if the board hasn't processed the completion yet (it will on the
      // API call we're about to trigger). So wake unconditionally here.
      await wake(parentID, `background-idle:${sessionId}`);
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
