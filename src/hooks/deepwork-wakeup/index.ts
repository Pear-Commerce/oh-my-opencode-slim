/**
 * Deepwork wakeup hook — the event-driven "/loop" equivalent.
 *
 * When a managed orchestrator delegates background work and goes idle, and a
 * background job later completes, the completion is injected into the
 * orchestrator's message stream — but only manifests on the NEXT API call.
 * If nothing re-triggers the idle orchestrator, it never sees the completion,
 * never reconciles, and the deepwork loop dies.
 *
 * This hook watches for two signals:
 *
 * 1. **Background session idle** — a non-managed (background) session goes
 *    idle, meaning a delegated task completed. If its parent orchestrator is
 *    managed and currently idle, wake the parent via `promptAsync`. The
 *    resulting API call runs `messages.transform`, which processes the
 *    injected completion, updates the job board, and injects the
 *    reconciliation reminder — giving the orchestrator everything it needs to
 *    continue.
 *
 * 2. **Orchestrator idle with unreconciled work** — a managed orchestrator
 *    goes idle while the board already knows about unreconciled terminal
 *    jobs (e.g. from a prior API call that the orchestrator didn't fully
 *    reconcile). Wake it to retry reconciliation.
 *
 * Termination: when no background sessions are running and no terminal jobs
 * are unreconciled, no wake fires. The orchestrator stays idle. The loop is
 * done.
 *
 * Safety: a dedup window prevents rapid re-waking, and a max-wakes-without-
 * progress guard stops the loop if the board state doesn't change between
 * wakes (the orchestrator is stuck or ignoring wakeups).
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { log } from '../../utils/logger';
import type { BackgroundJobBoard } from '../../utils/background-job-board';

const DEFAULT_DEDUP_WINDOW_MS = 3_000;
const DEFAULT_WAKE_DELAY_MS = 800;
const DEFAULT_MAX_WAKES_WITHOUT_PROGRESS = 8;

const WAKEUP_MESSAGE =
  'Background work is ready to reconcile. Review the Background Job Board and continue: reconcile terminal results, validate, and proceed to the next phase or finish if all work is complete.';

interface SessionWakeState {
  idle: boolean;
  lastWakeAt: number;
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

  const states = new Map<string, SessionWakeState>();

  function getState(sessionID: string): SessionWakeState {
    let s = states.get(sessionID);
    if (!s) {
      s = {
        idle: false,
        lastWakeAt: 0,
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

      await sessionClient.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text: WAKEUP_MESSAGE }],
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
        states.delete(sessionId);
        return;
      }

      // Busy clears idle state. Do NOT reset wakeCount here — it tracks
      // wakes without board progress across busy/idle cycles. Only a board
      // signature change (actual progress) resets it.
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

        // If the board already knows about unreconciled work, wake now.
        // Otherwise stay idle — if background jobs are still running, their
        // completion will fire their own session.idle and trigger Case 2.
        if (backgroundJobBoard.hasTerminalUnreconciled(sessionId)) {
          await wake(sessionId, 'orchestrator-idle-with-unreconciled');
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

      const parentState = getState(parentID);
      if (!parentState.idle) return;

      // The background session going idle IS the signal that work is ready,
      // even if the board hasn't processed the completion yet (it will on the
      // API call we're about to trigger). So wake unconditionally here.
      await wake(parentID, `background-idle:${sessionId}`);
    },

    /** @internal Exposed for testing */
    _states: states,
  };
}
