import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createDeepworkWakeupHook } from './index';

function makeClient() {
  const promptAsync = mock(async () => {});
  const client = {
    session: {
      promptAsync,
    },
  } as unknown as Parameters<typeof createDeepworkWakeupHook>[0];
  return { client, promptAsync };
}

function idleEvent(sessionId: string) {
  return {
    event: {
      type: 'session.idle',
      properties: { info: { id: sessionId } },
    },
  };
}

function statusIdleEvent(sessionId: string) {
  return {
    event: {
      type: 'session.status',
      properties: { info: { id: sessionId }, status: { type: 'idle' } },
    },
  };
}

function busyEvent(sessionId: string) {
  return {
    event: {
      type: 'session.status',
      properties: { info: { id: sessionId }, status: { type: 'busy' } },
    },
  };
}

function deletedEvent(sessionId: string) {
  return {
    event: {
      type: 'session.deleted',
      properties: { info: { id: sessionId } },
    },
  };
}

const FAST_OPTS = { wakeDelayMs: 0, dedupWindowMs: 0 };

describe('deepwork-wakeup hook', () => {
  test('wakes idle parent when a background session goes idle', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
      description: 'review',
    });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    // Parent orchestrator goes idle first
    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).not.toHaveBeenCalled();

    // Background oracle completes → wake parent
    await hook.event(idleEvent('ses_ora1'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const call = promptAsync.mock.calls[0]?.[0];
    expect(call.path.id).toBe('ses_orch');
    expect(call.body.parts[0].text).toContain('reconcile');
  });

  test('does not wake parent that is not idle', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    // Parent is NOT idle (never received idle event) → background idle should not wake
    await hook.event(idleEvent('ses_ora1'));
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not wake non-managed parent', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_other',
      agent: 'oracle',
    });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch', // only ses_orch is managed
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_other')); // parent idle but not managed
    await hook.event(idleEvent('ses_ora1'));
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not wake when background job is already reconciled', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_orch'));
    await hook.event(idleEvent('ses_ora1'));
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('wakes orchestrator on its own idle when board has unreconciled work', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    // terminalUnreconciled is now true

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('does not wake on orchestrator idle when no unreconciled work (termination)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1'); // fully reconciled

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not wake when only running jobs exist (do not poll)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    // job is still running, not terminal

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_orch'));
    // Orchestrator idle with only running jobs → don't wake (wait for completion)
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('dedup window prevents rapid re-waking', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 10_000, // large dedup window
    });

    await hook.event(idleEvent('ses_orch')); // wakes
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Second wake attempt within dedup window → skipped
    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('max wakes without progress stops the loop', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    // Board signature won't change between wakes (no reconciliation happening)

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      maxWakesWithoutProgress: 3,
    });

    // First wake: signature is new, wakeCount resets to 0
    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Busy → idle cycle (simulating orchestrator responding but not reconciling)
    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch')); // wake 2 (same sig, wakeCount=1)
    expect(promptAsync).toHaveBeenCalledTimes(2);

    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch')); // wake 3 (wakeCount=2)
    expect(promptAsync).toHaveBeenCalledTimes(3);

    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch')); // wake 4 (wakeCount=3, exceeds max)
    expect(promptAsync).toHaveBeenCalledTimes(3); // stopped, no new wake

    // Subsequent attempts also stopped
    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(3);
  });

  test('board progress resets wake count', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      maxWakesWithoutProgress: 2,
    });

    // Wake 1
    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Simulate reconciliation: board signature changes
    board.markReconciled('ses_ora1');
    board.registerLaunch({
      taskID: 'ses_ora2',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora2', state: 'completed' });

    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch')); // new signature → wakeCount resets
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });

  test('busy event clears idle state', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_orch')); // idle + wake
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await hook.event(busyEvent('ses_orch')); // busy → not idle

    // Background completes while parent is busy → should NOT wake (parent not idle)
    await hook.event(idleEvent('ses_ora1'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('session.deleted cleans up state', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Delete the orchestrator session
    await hook.event(deletedEvent('ses_orch'));

    // State is cleaned up — re-creating idle won't wake because state is fresh
    // (idle=false until a new idle event sets it)
    const states = (hook as unknown as { _states: Map<string, unknown> })
      ._states;
    expect(states.has('ses_orch')).toBe(false);
  });

  test('handles session.status idle variant', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    // Use session.status with idle instead of session.idle
    await hook.event(statusIdleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('ignores events without session id', async () => {
    const board = new BackgroundJobBoard();
    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      ...FAST_OPTS,
    });

    await hook.event({ event: { type: 'session.idle', properties: {} } });
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('ignores idle on unknown background session (no board entry)', async () => {
    const board = new BackgroundJobBoard();
    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: () => true,
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_orch'));
    // Unknown background session with no board entry
    await hook.event(idleEvent('ses_unknown'));
    expect(promptAsync).not.toHaveBeenCalled();
  });

  // ── Periodic wakeup interval tests ──────────────────────────────────

  test('periodic timer starts when orchestrator with background history goes idle', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 50, // fast for testing
    });

    // Background completes → marks hasHadBackgroundWork + wakes parent
    await hook.event(idleEvent('ses_orch'));
    await hook.event(idleEvent('ses_ora1'));
    expect(promptAsync).toHaveBeenCalledTimes(1);

    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(true);
  });

  test('periodic timer does NOT start for orchestrator without background history', async () => {
    const board = new BackgroundJobBoard();
    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 50,
    });

    // Just goes idle, no background work ever
    await hook.event(idleEvent('ses_orch'));
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false);
  });

  test('periodic timer wakes orchestrator after interval', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30, // very fast
    });

    // Mark hasHadBackgroundWork by having had a background job
    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Orchestrator goes idle → timer starts
    await hook.event(idleEvent('ses_orch'));

    // Wait for at least 2 intervals
    await new Promise((r) => setTimeout(r, 80));

    // Should have been woken at least once by the periodic timer
    expect(promptAsync.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('periodic timer does not wake when orchestrator is busy', async () => {
    const board = new BackgroundJobBoard();
    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Orchestrator goes idle → timer starts
    await hook.event(idleEvent('ses_orch'));

    // Orchestrator goes busy
    await hook.event(busyEvent('ses_orch'));

    // Wait for intervals
    await new Promise((r) => setTimeout(r, 80));

    // Should NOT have been woken (was busy during all intervals)
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('periodic timer is cleared on session.deleted', async () => {
    const board = new BackgroundJobBoard();
    const { client } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 50,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    await hook.event(idleEvent('ses_orch'));
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(true);

    await hook.event(deletedEvent('ses_orch'));
    expect(timers.has('ses_orch')).toBe(false);
  });

  test('periodic timer stops after max no-op wakes', async () => {
    const board = new BackgroundJobBoard();
    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      maxWakesWithoutProgress: 3,
      intervalMs: 20,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Orchestrator goes idle → timer starts
    await hook.event(idleEvent('ses_orch'));

    // Wait for enough intervals to exceed maxWakes
    // Each interval: wake → promptAsync → (no busy event, stays idle) → next interval
    await new Promise((r) => setTimeout(r, 150));

    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false); // timer cleared after maxWakes

    // Total wakes should be around maxWakes (not unbounded)
    expect(promptAsync.mock.calls.length).toBeLessThanOrEqual(4);
  });

  test('foreground progress resets wakeCount (busy > 5s after wake)', async () => {
    const board = new BackgroundJobBoard();
    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      maxWakesWithoutProgress: 3,
      intervalMs: 20,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Orchestrator goes idle → timer starts → first wake
    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 25));

    // Simulate: wake happened 10s ago, orchestrator went busy 9s ago,
    // was busy for 9s (real foreground work), now going idle.
    const states = (hook as unknown as { _states: Map<string, { lastBusyAt: number; lastWakeAt: number; wakeCount: number }> })._states;
    const state = states.get('ses_orch')!;
    const now = Date.now();
    state.lastWakeAt = now - 10_000; // wake 10s ago
    state.lastBusyAt = now - 9_000; // busy 9s ago (1s after wake)
    state.wakeCount = 2; // pretend we've had 2 no-op wakes before this

    // Orchestrator goes idle → should detect foreground progress → reset wakeCount
    await hook.event(idleEvent('ses_orch'));
    expect(state.wakeCount).toBe(0);

    // Timer should still be running (not stopped)
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(true);

    hook._destroy();
  });

  test('_destroy clears all timers', async () => {
    const board = new BackgroundJobBoard();
    const { client } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: () => true, // all sessions managed
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 50,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');
    hasHad.add('ses_orch2');

    await hook.event(idleEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch2'));

    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.size).toBe(2);

    hook._destroy();
    expect(timers.size).toBe(0);
  });

  test('periodic timer uses different wakeup message than event-driven', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
    });

    // Event-driven wake (unreconciled work)
    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const eventMsg = promptAsync.mock.calls[0]?.[0].body.parts[0].text;
    expect(eventMsg).toContain('reconcile');

    // Reconcile the job so board is empty
    board.markReconciled('ses_ora1');

    // Wait for periodic timer
    await new Promise((r) => setTimeout(r, 50));

    // Periodic wake should use different message
    const periodicCall = promptAsync.mock.calls[promptAsync.mock.calls.length - 1]?.[0];
    if (periodicCall) {
      expect(periodicCall.body.parts[0].text).toContain('Periodic wakeup');
    }

    hook._destroy();
  });
});
