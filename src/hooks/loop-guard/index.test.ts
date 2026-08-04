import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearLoopState,
  createLoopGuardHook,
  _internals,
} from './index';

const { reset, WARN_THRESHOLD, HARD_THRESHOLD, LOOP_NUDGE_MARKER, LOOP_INTERRUPT_MARKER } =
  _internals;

describe('loop-guard', () => {
  let hook: ReturnType<typeof createLoopGuardHook>;

  beforeEach(() => {
    reset();
    hook = createLoopGuardHook();
  });

  const callBefore = async (
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
  ): Promise<void> => {
    await hook['tool.execute.before'](
      { tool, sessionID, callID },
      { args },
    );
  };

  const callAfter = async (
    tool: string,
    sessionID: string,
    callID: string,
    output: string,
  ): Promise<string> => {
    const out = { output };
    await hook['tool.execute.after'](
      { tool, sessionID, callID },
      out,
    );
    return typeof out.output === 'string' ? out.output : '';
  };

  const readArgs = {
    filePath: '/test/file.ts',
    offset: 690,
    limit: 80,
  };

  test('no intervention below warn threshold', async () => {
    const sid = 's1';
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const cid = `c${i}`;
      await callBefore('read', sid, cid, readArgs);
      const result = await callAfter('read', sid, cid, 'file content here');
      expect(result).toBe('file content here');
      expect(result).not.toContain(LOOP_NUDGE_MARKER);
    }
  });

  test('appends nudge at warn threshold', async () => {
    const sid = 's2';
    // First two calls: no nudge
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const cid = `c${i}`;
      await callBefore('read', sid, cid, readArgs);
      await callAfter('read', sid, cid, 'file content');
    }
    // Third call: nudge appended
    const cid = `c${WARN_THRESHOLD}`;
    await callBefore('read', sid, cid, readArgs);
    const result = await callAfter('read', sid, cid, 'file content');
    expect(result).toContain('file content');
    expect(result).toContain(LOOP_NUDGE_MARKER);
    expect(result).toContain('3 times');
  });

  test('replaces output at hard threshold', async () => {
    const sid = 's3';
    // Calls 1 through HARD_THRESHOLD-1: nudge appended
    for (let i = 1; i < HARD_THRESHOLD; i++) {
      const cid = `c${i}`;
      await callBefore('read', sid, cid, readArgs);
      await callAfter('read', sid, cid, 'file content');
    }
    // Call HARD_THRESHOLD: output replaced
    const cid = `c${HARD_THRESHOLD}`;
    await callBefore('read', sid, cid, readArgs);
    const result = await callAfter('read', sid, cid, 'file content');
    expect(result).not.toContain('file content');
    expect(result).toContain(LOOP_INTERRUPT_MARKER);
    expect(result).toContain('5th');
  });

  test('different tool call resets counter', async () => {
    const sid = 's4';
    // Two identical reads
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const cid = `c${i}`;
      await callBefore('read', sid, cid, readArgs);
      await callAfter('read', sid, cid, 'content');
    }
    // Different tool (edit) — resets counter
    const editCid = 'ce1';
    await callBefore('edit', sid, editCid, {
      filePath: '/test/file.ts',
      oldString: 'a',
      newString: 'b',
    });
    const editResult = await callAfter('edit', sid, editCid, 'Edit applied');
    expect(editResult).toBe('Edit applied');

    // Read again — should be count=1, no nudge
    const readCid = 'cr1';
    await callBefore('read', sid, readCid, readArgs);
    const readResult = await callAfter('read', sid, readCid, 'content');
    expect(readResult).toBe('content');
    expect(readResult).not.toContain(LOOP_NUDGE_MARKER);
  });

  test('read-after-edit is not a loop', async () => {
    const sid = 's5';
    // read → edit → read → edit → read — never accumulates
    for (let cycle = 0; cycle < 5; cycle++) {
      const readCid = `r${cycle}`;
      await callBefore('read', sid, readCid, readArgs);
      const r = await callAfter('read', sid, readCid, 'content');
      expect(r).not.toContain(LOOP_NUDGE_MARKER);

      const editCid = `e${cycle}`;
      await callBefore('edit', sid, editCid, {
        filePath: '/test/file.ts',
        oldString: 'a',
        newString: 'b',
      });
      const e = await callAfter('edit', sid, editCid, 'Edit applied');
      expect(e).not.toContain(LOOP_NUDGE_MARKER);
    }
  });

  test('different args on same tool resets counter', async () => {
    const sid = 's6';
    // read offset=690
    await callBefore('read', sid, 'c1', { ...readArgs, offset: 690 });
    await callAfter('read', sid, 'c1', 'content A');

    // read offset=100 — different fingerprint
    await callBefore('read', sid, 'c2', { ...readArgs, offset: 100 });
    const result = await callAfter('read', sid, 'c2', 'content B');
    expect(result).toBe('content B');
    expect(result).not.toContain(LOOP_NUDGE_MARKER);
  });

  test('per-session isolation', async () => {
    const sidA = 'sA';
    const sidB = 'sB';

    // Session A: 2 identical reads
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const cid = `a${i}`;
      await callBefore('read', sidA, cid, readArgs);
      await callAfter('read', sidA, cid, 'content');
    }

    // Session B: 2 identical reads — should NOT see session A's count
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const cid = `b${i}`;
      await callBefore('read', sidB, cid, readArgs);
      const result = await callAfter('read', sidB, cid, 'content');
      expect(result).not.toContain(LOOP_NUDGE_MARKER);
    }
  });

  test('missing sessionID or callID is a no-op', async () => {
    await callBefore('read', '', 'c1', readArgs);
    // Should not throw, should not track
    const result = await callAfter('read', 's7', 'c1', 'content');
    expect(result).toBe('content');
  });

  test('non-string output is skipped', async () => {
    const sid = 's8';
    for (let i = 1; i < HARD_THRESHOLD; i++) {
      const cid = `c${i}`;
      await callBefore('read', sid, cid, readArgs);
      await hook['tool.execute.after'](
        { tool: 'read', sessionID: sid, callID: cid },
        { output: { nonString: true } },
      );
    }
    // Even at threshold, non-string output is not modified
    const cid = `c${HARD_THRESHOLD}`;
    await callBefore('read', sid, cid, readArgs);
    const out = { output: { nonString: true } };
    await hook['tool.execute.after'](
      { tool: 'read', sessionID: sid, callID: cid },
      out,
    );
    expect(out.output).toEqual({ nonString: true });
  });

  test('idempotency: does not double-inject nudge', async () => {
    const sid = 's9';
    // Get to warn threshold
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const cid = `c${i}`;
      await callBefore('read', sid, cid, readArgs);
      await callAfter('read', sid, cid, 'content');
    }
    // Call that already contains the marker
    const cid = `c${WARN_THRESHOLD}`;
    await callBefore('read', sid, cid, readArgs);
    const preMarked = `content\n${LOOP_NUDGE_MARKER}\nold nudge`;
    const result = await callAfter('read', sid, cid, preMarked);
    // Should not append a second nudge
    const markerCount = result.split(LOOP_NUDGE_MARKER).length - 1;
    expect(markerCount).toBe(1);
  });

  test('clearLoopState removes session tracking', async () => {
    const sid = 's10';
    // Accumulate 2 identical reads
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const cid = `c${i}`;
      await callBefore('read', sid, cid, readArgs);
      await callAfter('read', sid, cid, 'content');
    }
    // Clear state
    clearLoopState(sid);

    // Next read should be count=1, no nudge
    const cid = 'c1fresh';
    await callBefore('read', sid, cid, readArgs);
    const result = await callAfter('read', sid, cid, 'content');
    expect(result).toBe('content');
    expect(result).not.toContain(LOOP_NUDGE_MARKER);
  });

  test('fingerprint is order-independent for object args', async () => {
    const sid = 's11';
    const argsA = { filePath: '/x.ts', limit: 80, offset: 690 };
    const argsB = { offset: 690, filePath: '/x.ts', limit: 80 };

    await callBefore('read', sid, 'c1', argsA);
    await callAfter('read', sid, 'c1', 'content');

    // Same args, different key order — should be same fingerprint
    await callBefore('read', sid, 'c2', argsB);
    const result = await callAfter('read', sid, 'c2', 'content');
    // count should be 2, not 1 — no nudge yet (below threshold)
    expect(result).toBe('content');
    expect(result).not.toContain(LOOP_NUDGE_MARKER);
  });

  test('escalation continues past hard threshold', async () => {
    const sid = 's12';
    for (let i = 1; i <= HARD_THRESHOLD + 3; i++) {
      const cid = `c${i}`;
      await callBefore('read', sid, cid, readArgs);
      const result = await callAfter('read', sid, cid, 'file content');
      if (i >= HARD_THRESHOLD) {
        expect(result).toContain(LOOP_INTERRUPT_MARKER);
        expect(result).not.toContain('file content');
      } else if (i >= WARN_THRESHOLD) {
        expect(result).toContain(LOOP_NUDGE_MARKER);
      } else {
        expect(result).toBe('file content');
      }
    }
  });
});
