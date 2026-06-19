import { describe, expect, test, mock } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createDeepworkWakeupHook } from './index';

function makeClient(lastAssistantText = 'no') {
  const promptAsync = mock(async () => {});
  const messages = mock(async () => ({
    data: [
      {
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'are you done?' }],
      },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: lastAssistantText }],
      },
    ],
  }));
  const client = {
    session: { promptAsync, messages },
  } as unknown as Parameters<typeof createDeepworkWakeupHook>[0];
  return { client, promptAsync, messages };
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
const FAST_OPTS_WITH_READ = {
  wakeDelayMs: 0,
  dedupWindowMs: 0,
  messageReadDelayMs: 0,
};

describe('deepwork-wakeup hook', () => {
  // ── Event-driven wake tests ─────────────────────────────────────────

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

    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).not.toHaveBeenCalled();

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
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_other'));
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

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      ...FAST_OPTS,
    });

    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('does not wake on orchestrator idle when no unreconciled work (no event wake)', async () => {
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
    // No event-driven wake (board is clean), but timer starts (has background history)
    // The timer hasn't fired yet, so no promptAsync
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not event-wake when only running jobs exist', async () => {
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

    await hook.event(idleEvent('ses_orch'));
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
      dedupWindowMs: 10_000,
    });

    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
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

    await hook.event(idleEvent('ses_orch'));
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await hook.event(busyEvent('ses_orch'));

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

    await hook.event(deletedEvent('ses_orch'));

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
    await hook.event(idleEvent('ses_unknown'));
    expect(promptAsync).not.toHaveBeenCalled();
  });

  // ── Periodic done-check interval tests ──────────────────────────────

  test('periodic timer starts when orchestrator with background history goes idle', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });

    const { client } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 50,
    });

    await hook.event(idleEvent('ses_orch'));
    await hook.event(idleEvent('ses_ora1'));

    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(true);
    hook._destroy();
  });

  test('periodic timer does NOT start for orchestrator without background history', async () => {
    const board = new BackgroundJobBoard();
    const { client } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 50,
    });

    await hook.event(idleEvent('ses_orch'));
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false);
  });

  test('periodic timer sends done-check question, then continue prompt on "no"', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync, messages } = makeClient('no');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Orchestrator goes idle → timer starts
    await hook.event(idleEvent('ses_orch'));

    // Wait for timer to fire (sends done-check)
    await new Promise((r) => setTimeout(r, 40));

    // First promptAsync should be the done-check question
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0].body.parts[0].text).toContain('yes or no');

    // Simulate: orchestrator becomes busy (processing the question)
    await hook.event(busyEvent('ses_orch'));

    // Orchestrator responds and goes idle → handleDoneCheckResponse fires
    await hook.event(idleEvent('ses_orch'));

    // Should have read the response and sent continue prompt
    expect(messages).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls[1]?.[0].body.parts[0].text).toContain('Continue');

    hook._destroy();
  });

  test('periodic timer stops on "yes" answer', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync } = makeClient('yes');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    await hook.event(idleEvent('ses_orch'));

    // Wait for done-check
    await new Promise((r) => setTimeout(r, 40));

    // Orchestrator processes and responds
    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch'));

    // Timer should be cleared (orchestrator said yes)
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false);

    // Only one promptAsync call (the done-check), no continue prompt
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });

  test('"yes" is overridden when unreconciled work remains', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1'); // start clean so done-check fires, not event wake

    const { client, promptAsync } = makeClient('yes');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 40));

    // Now add unreconciled work (simulates background job completing during done-check)
    board.registerLaunch({
      taskID: 'ses_ora2',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora2', state: 'completed' });
    // ses_ora2 is now terminalUnreconciled

    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch'));

    // Should NOT have stopped — should have sent continue prompt
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(true);
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls[1]?.[0].body.parts[0].text).toContain('Continue');

    hook._destroy();
  });

  test('periodic timer does not fire when orchestrator is busy', async () => {
    const board = new BackgroundJobBoard();
    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    await hook.event(idleEvent('ses_orch'));
    await hook.event(busyEvent('ses_orch'));

    await new Promise((r) => setTimeout(r, 80));

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

  test('safety cap stops timer after too many "no" answers without board progress', async () => {
    const board = new BackgroundJobBoard();
    const { client, promptAsync } = makeClient('no');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 20,
      messageReadDelayMs: 0,
      maxNoProgress: 3,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Start the timer
    await hook.event(idleEvent('ses_orch'));

    // Manually set consecutiveNoProgress to just below the cap
    const states = (hook as unknown as { _states: Map<string, { consecutiveNoProgress: number }> })._states;
    states.get('ses_orch')!.consecutiveNoProgress = 2;

    // Wait for timer to fire — it should send a done-check
    await new Promise((r) => setTimeout(r, 25));
    expect(promptAsync).toHaveBeenCalledTimes(1); // done-check sent

    // Simulate: busy → idle → handleDoneCheckResponse → "no" → consecutiveNoProgress becomes 3
    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch'));
    expect(states.get('ses_orch')!.consecutiveNoProgress).toBe(3);

    // Orchestrator processes continue prompt, does "work", goes idle again
    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch'));

    // Wait for the next timer tick — should check 3 >= 3 and clear the timer
    await new Promise((r) => setTimeout(r, 25));

    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false);
  });

  test('ambiguous response defaults to "no" (keep working)', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync } = makeClient('maybe, let me check');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 40));

    await hook.event(busyEvent('ses_orch'));
    await hook.event(idleEvent('ses_orch'));

    // Ambiguous → defaults to "no" → continue prompt sent
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(promptAsync.mock.calls[1]?.[0].body.parts[0].text).toContain('Continue');

    hook._destroy();
  });

  test('_destroy clears all timers', async () => {
    const board = new BackgroundJobBoard();
    const { client } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: () => true,
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

  test('done-check does not interfere with event-driven wake', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1'); // no running jobs so done-check can fire

    const { client, promptAsync } = makeClient('no');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Orchestrator idle → timer starts
    await hook.event(idleEvent('ses_orch'));

    // Wait for done-check to fire
    await new Promise((r) => setTimeout(r, 40));
    expect(promptAsync).toHaveBeenCalledTimes(1); // done-check sent

    // Orchestrator is now busy with done-check
    await hook.event(busyEvent('ses_orch'));

    // While busy, a NEW background job completes — should NOT trigger event
    // wake (parent not idle, and a done-check is in flight)
    board.registerLaunch({
      taskID: 'ses_ora2',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora2', state: 'completed' });
    await hook.event(idleEvent('ses_ora2'));

    // Still only the done-check prompt, no event-driven wake (parent busy)
    expect(promptAsync).toHaveBeenCalledTimes(1);

    hook._destroy();
  });

  test('done-check does not fire while background jobs are running', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_fix1',
      parentSessionID: 'ses_orch',
      agent: 'fixer',
    });
    // job is still running (not terminal)

    const { client, promptAsync } = makeClient('no');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Orchestrator goes idle (correctly waiting for fixer) → timer starts
    await hook.event(idleEvent('ses_orch'));

    // Wait for multiple intervals — done-check should NOT fire (fixer running)
    await new Promise((r) => setTimeout(r, 100));

    expect(promptAsync).not.toHaveBeenCalled();

    // Now fixer completes → event-driven wake fires (not done-check)
    board.updateStatus({ taskID: 'ses_fix1', state: 'completed' });
    await hook.event(idleEvent('ses_fix1'));
    expect(promptAsync).toHaveBeenCalledTimes(1);
    // The wake should be the event-driven reconcile message, not the done-check
    expect(promptAsync.mock.calls[0]?.[0].body.parts[0].text).toContain('reconcile');

    hook._destroy();
  });

  test('done-check fires after background jobs complete and reconcile', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_fix1',
      parentSessionID: 'ses_orch',
      agent: 'fixer',
    });
    board.updateStatus({ taskID: 'ses_fix1', state: 'completed' });
    board.markReconciled('ses_fix1'); // no running jobs, no unreconciled

    const { client, promptAsync } = makeClient('no');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    await hook.event(idleEvent('ses_orch'));

    // Wait for timer — done-check SHOULD fire (no running jobs)
    await new Promise((r) => setTimeout(r, 40));
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0].body.parts[0].text).toContain('yes or no');

    hook._destroy();
  });

  // ── Race condition tests ────────────────────────────────────────────

  test('does not send prompt if orchestrator becomes busy during wake delay', async () => {
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
      wakeDelayMs: 50, // give us time to inject a busy event during the delay
      dedupWindowMs: 0,
    });

    // Orchestrator goes idle with unreconciled work → triggers event wake
    // We need to intercept: the wake starts, sleeps 50ms, but we send a
    // busy event during that sleep.
    const idlePromise = hook.event(idleEvent('ses_orch'));

    // Immediately send busy event (during the 50ms wake delay)
    await new Promise((r) => setTimeout(r, 10));
    await hook.event(busyEvent('ses_orch'));

    // Now wait for the idle promise to resolve (wake delay finishes)
    await idlePromise;

    // The prompt should NOT have been sent — orchestrator became busy
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not send continue prompt if orchestrator became busy during done-check response read', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync } = makeClient('no');
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 50, // give us time to inject busy during read
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Start: idle → timer fires → done-check sent
    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 40));
    expect(promptAsync).toHaveBeenCalledTimes(1); // done-check sent

    // Orchestrator processes done-check, responds, goes idle
    // This triggers handleDoneCheckResponse which reads response (50ms delay)
    const responsePromise = (async () => {
      await hook.event(busyEvent('ses_orch'));
      await hook.event(idleEvent('ses_orch'));
    })();

    // During the 50ms read delay, inject a busy event (user started working)
    await new Promise((r) => setTimeout(r, 20));
    await hook.event(busyEvent('ses_orch'));

    await responsePromise;
    // Wait for handleDoneCheckResponse to finish
    await new Promise((r) => setTimeout(r, 60));

    // The continue prompt should NOT have been sent — orchestrator became
    // busy during the read delay, and sendPrompt's post-delay idle check
    // should have aborted.
    // Total promptAsync calls: 1 (done-check only, no continue)
    expect(promptAsync).toHaveBeenCalledTimes(1);

    hook._destroy();
  });
});
