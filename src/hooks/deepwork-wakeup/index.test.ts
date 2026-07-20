import { describe, expect, test, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import { createDeepworkWakeupHook, type LoopGate } from './index';

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
  const create = mock(async () => ({ data: { id: 'ses_adjudicator' } }));
  const prompt = mock(async () => {});
  const abort = mock(async () => {});
  const client = {
    session: { promptAsync, messages, create, prompt, abort },
  } as unknown as Parameters<typeof createDeepworkWakeupHook>[0];
  return { client, promptAsync, messages, create, prompt, abort };
}

function makeAdjudicatorClient(adjudicatorResponse: string, lastAssistantText = 'no') {
  const base = makeClient(lastAssistantText);
  base.messages = mock(async (args: { path: { id: string } }) => {
    // Return different responses based on session ID
    if (args.path.id === 'ses_adjudicator') {
      return {
        data: [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: adjudicatorResponse }],
          },
        ],
      };
    }
    return {
      data: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'q' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: lastAssistantText }] },
      ],
    };
  });
  base.client.session.messages = base.messages;
  return base;
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

  // ── Gate-based termination tests ────────────────────────────────────

  function makeGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gate-test-'));
    execSync('git init -q', { cwd: dir });
    return dir;
  }

  test('command gate: pass (exit 0) stops the loop', async () => {
    const dir = makeGitRepo();
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
      intervalMs: 30,
      messageReadDelayMs: 0,
      directory: dir,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Set a command gate that always passes
    hook.setGate('ses_orch', { type: 'command', command: 'true' });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 50));

    // Gate passed → timer cleared, no continue prompt sent
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('command gate: fail (non-zero) sends continue prompt', async () => {
    const dir = makeGitRepo();
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
      intervalMs: 30,
      messageReadDelayMs: 0,
      directory: dir,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    // Set a command gate that always fails
    hook.setGate('ses_orch', { type: 'command', command: 'false' });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 50));

    // Gate failed → continue prompt sent with gate output
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const msg = promptAsync.mock.calls[0]?.[0].body.parts[0].text;
    expect(msg).toContain('gate failed');
  });

  test('command gate: pass overridden when unreconciled work remains', async () => {
    const dir = makeGitRepo();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    // NOT reconciled — terminalUnreconciled is true

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      directory: dir,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    hook.setGate('ses_orch', { type: 'command', command: 'true' });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 50));

    // Gate passed but unreconciled work → continue prompt sent, timer still running
    expect(promptAsync).toHaveBeenCalledTimes(1);
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(true);

    hook._destroy();
  });

  test('adjudicator gate: PASS stops the loop', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync, create, abort, prompt } = makeAdjudicatorClient('PASS\nAll clear.');

    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      pollIntervalMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    hook.setGate('ses_orch', {
      type: 'adjudicator',
      prompt: 'Check for blended RVR numbers.',
      model: 'openai/gpt-4.1-mini',
    });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 50));

    // Adjudicator spawned and said PASS → timer cleared
    expect(create).toHaveBeenCalledTimes(1);
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false);
    // promptAsync called once for the adjudicator prompt (not for continue)
    expect(promptAsync).toHaveBeenCalledTimes(1);
    // Start notification injected into the parent session (noReply) so the
    // user can follow the adjudicator in the TUI.
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]?.[0].body.parts[0].text).toContain('Gate adjudicator running');
    // PASS → adjudicator session left intact for review (not aborted)
    expect(abort).not.toHaveBeenCalled();
  });

  test('adjudicator gate: timeout/stall aborts the adjudicator session', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    // Adjudicator session never produces an assistant message → poll times out
    const promptAsync = mock(async () => {});
    const messages = mock(async (args: { path: { id: string } }) => {
      if (args.path.id === 'ses_adjudicator') {
        return {
          data: [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'q' }] }],
        };
      }
      return {
        data: [
          { info: { role: 'user' }, parts: [{ type: 'text', text: 'q' }] },
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'no' }] },
        ],
      };
    });
    const create = mock(async () => ({ data: { id: 'ses_adjudicator' } }));
    const prompt = mock(async () => {});
    const abort = mock(async () => {});
    const client = {
      session: { promptAsync, messages, create, prompt, abort },
    } as unknown as Parameters<typeof createDeepworkWakeupHook>[0];

    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      pollIntervalMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    hook.setGate('ses_orch', {
      type: 'adjudicator',
      prompt: 'Check for blended RVR numbers.',
      model: 'openai/gpt-4.1-mini',
      timeoutMs: 50,
    });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 120));

    // Timed out → abort called to stop the stalled session
    expect(abort).toHaveBeenCalledTimes(1);
    // Continue prompt sent to orchestrator with the timeout output
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const msg = promptAsync.mock.calls[1]?.[0].body.parts[0].text;
    expect(msg).toContain('gate failed');
    expect(msg).toContain('timed out');
  });

  test('adjudicator gate: attaches files as file parts', async () => {
    const dir = makeGitRepo();
    // Create a test file for the adjudicator to "review"
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'deck.md'), '# Slide 1\nRVR declined 19.1pp\n');

    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync, create } = makeAdjudicatorClient('FAIL\nBlended RVR found.');

    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      pollIntervalMs: 0,
      directory: dir,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    hook.setGate('ses_orch', {
      type: 'adjudicator',
      prompt: 'Check the attached deck for blended RVR numbers.',
      files: ['docs/deck.md'],
    });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 50));

    // Adjudicator was spawned
    expect(create).toHaveBeenCalledTimes(1);
    // promptAsync called twice: 1=adjudicator prompt (with files), 2=continue prompt
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const promptCall = promptAsync.mock.calls[0]?.[0];
    const parts = promptCall.body.parts;
    // First part is the text prompt
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('PASS or FAIL');
    // Second part should be the file attachment
    expect(parts.length).toBe(2);
    expect(parts[1].type).toBe('file');
    expect(parts[1].filename).toBe('deck.md');
    expect(parts[1].mime).toBe('text/markdown');
    expect(parts[1].url).toContain('data:text/markdown;base64,');
  });

  test('adjudicator gate: resolves relative file paths against directory', async () => {
    const dir = makeGitRepo();
    mkdirSync(join(dir, 'output'), { recursive: true });
    writeFileSync(join(dir, 'output', 'report.json'), '{"rvr": "19.1pp blended"}');

    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync } = makeAdjudicatorClient('FAIL');

    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      pollIntervalMs: 0,
      directory: dir,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    hook.setGate('ses_orch', {
      type: 'adjudicator',
      prompt: 'Check report.',
      files: ['output/report.json'], // relative path
    });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 50));

    const parts = promptAsync.mock.calls[0]?.[0].body.parts;
    expect(parts[1].filename).toBe('report.json');
  });

  test('adjudicator gate: missing file is skipped gracefully', async () => {
    const dir = makeGitRepo();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync } = makeAdjudicatorClient('PASS');

    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      pollIntervalMs: 0,
      directory: dir,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    hook.setGate('ses_orch', {
      type: 'adjudicator',
      prompt: 'Check.',
      files: ['nonexistent.md', 'also-missing.json'],
    });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 50));

    // Missing files skipped — only the text prompt part remains
    const parts = promptAsync.mock.calls[0]?.[0].body.parts;
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('text');
  });

  test('adjudicator gate: FAIL sends continue prompt', async () => {
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_ora1',
      parentSessionID: 'ses_orch',
      agent: 'oracle',
    });
    board.updateStatus({ taskID: 'ses_ora1', state: 'completed' });
    board.markReconciled('ses_ora1');

    const { client, promptAsync } = makeAdjudicatorClient(
      'FAIL\nSlide 2 has a blended RVR number.',
    );

    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      pollIntervalMs: 0,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    hook.setGate('ses_orch', {
      type: 'adjudicator',
      prompt: 'Check for blended RVR numbers.',
    });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 50));

    // Adjudicator said FAIL → continue prompt with adjudicator output
    // promptAsync called twice: 1=adjudicator prompt, 2=continue prompt to orchestrator
    expect(promptAsync).toHaveBeenCalledTimes(2);
    const msg = promptAsync.mock.calls[1]?.[0].body.parts[0].text;
    expect(msg).toContain('gate failed');
    expect(msg).toContain('FAIL');
    expect(msg).toContain('blended RVR');
  });

  test('clearing gate reverts to model yes/no done-check', async () => {
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

    // Set a command gate, then clear it
    hook.setGate('ses_orch', { type: 'command', command: 'true' });
    hook.setGate('ses_orch', undefined);

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 40));

    // Should use model done-check (sends the yes/no question)
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0].body.parts[0].text).toContain('yes or no');
  });

  test('gate does not fire while background jobs are running', async () => {
    const dir = makeGitRepo();
    const board = new BackgroundJobBoard();
    board.registerLaunch({
      taskID: 'ses_fix1',
      parentSessionID: 'ses_orch',
      agent: 'fixer',
    });
    // job still running

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      directory: dir,
    });

    const hasHad = (hook as unknown as { _hasHadBackgroundWork: Set<string> })._hasHadBackgroundWork;
    hasHad.add('ses_orch');

    hook.setGate('ses_orch', { type: 'command', command: 'true' });

    await hook.event(idleEvent('ses_orch'));
    await new Promise((r) => setTimeout(r, 100));

    // Fixer running → gate should not fire
    expect(promptAsync).not.toHaveBeenCalled();
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(true); // timer still running, waiting

    hook._destroy();
  });

  test('gate starts periodic timer even without background work history', async () => {
    // Regression: setting a gate on a session that never launched background
    // tasks must still start the periodic timer. The gate itself is the
    // signal that this is a convergence loop.
    const dir = makeGitRepo();
    const board = new BackgroundJobBoard();
    // No background tasks registered — board is empty

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      directory: dir,
    });

    // No hasHadBackgroundWork — session has no background history

    // Orchestrator goes idle first (no timer starts — no background work, no gate)
    await hook.event(idleEvent('ses_orch'));
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false);

    // Now set a gate — timer should start immediately (session is idle)
    hook.setGate('ses_orch', { type: 'command', command: 'true' });
    expect(timers.has('ses_orch')).toBe(true);

    // Wait for the gate to fire
    await new Promise((r) => setTimeout(r, 50));

    // Gate passed (exit 0) → timer cleared, no continue prompt
    expect(timers.has('ses_orch')).toBe(false);
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('gate set while session is busy starts timer after session goes idle', async () => {
    const dir = makeGitRepo();
    const board = new BackgroundJobBoard();

    const { client, promptAsync } = makeClient();
    const hook = createDeepworkWakeupHook(client, {
      backgroundJobBoard: board,
      shouldManageSession: (id) => id === 'ses_orch',
      wakeDelayMs: 0,
      dedupWindowMs: 0,
      intervalMs: 30,
      messageReadDelayMs: 0,
      directory: dir,
    });

    // Session is busy — set gate (timer should NOT start yet)
    hook.setGate('ses_orch', { type: 'command', command: 'false' });
    const timers = (hook as unknown as { _timers: Map<string, unknown> })._timers;
    expect(timers.has('ses_orch')).toBe(false);

    // Session goes idle — timer should start now (gate is set)
    await hook.event(idleEvent('ses_orch'));
    expect(timers.has('ses_orch')).toBe(true);

    hook._destroy();
  });
});
