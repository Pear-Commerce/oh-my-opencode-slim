import { beforeEach, describe, expect, test } from 'bun:test';
import { _internals, clearLoopState, createLoopGuardHook } from './index';

const {
  reset,
  WARN_THRESHOLD,
  HARD_THRESHOLD,
  WINDOW_SIZE,
  LOOP_NUDGE_MARKER,
  LOOP_INTERRUPT_MARKER,
} = _internals;

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
    await hook['tool.execute.before']({ tool, sessionID, callID }, { args });
  };

  const callAfter = async (
    tool: string,
    sessionID: string,
    callID: string,
    output: string,
  ): Promise<string> => {
    const out = { output };
    await hook['tool.execute.after']({ tool, sessionID, callID }, out);
    return typeof out.output === 'string' ? out.output : '';
  };

  /** Simulate a full tool call (before + after) and return the output. */
  const callTool = async (
    tool: string,
    sessionID: string,
    callID: string,
    args: unknown,
    output: string,
  ): Promise<string> => {
    await callBefore(tool, sessionID, callID, args);
    return callAfter(tool, sessionID, callID, output);
  };

  const readArgs = {
    filePath: '/test/file.ts',
    offset: 690,
    limit: 80,
  };

  test('no intervention below warn threshold', async () => {
    const sid = 's1';
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const result = await callTool(
        'read',
        sid,
        `c${i}`,
        readArgs,
        'file content here',
      );
      expect(result).toBe('file content here');
      expect(result).not.toContain(LOOP_NUDGE_MARKER);
    }
  });

  test('appends nudge at warn threshold (consecutive)', async () => {
    const sid = 's2';
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      await callTool('read', sid, `c${i}`, readArgs, 'file content');
    }
    const result = await callTool(
      'read',
      sid,
      `c${WARN_THRESHOLD}`,
      readArgs,
      'file content',
    );
    expect(result).toContain('file content');
    expect(result).toContain(LOOP_NUDGE_MARKER);
    expect(result).toContain('3 times');
  });

  test('replaces output at hard threshold (consecutive)', async () => {
    const sid = 's3';
    for (let i = 1; i < HARD_THRESHOLD; i++) {
      await callTool('read', sid, `c${i}`, readArgs, 'file content');
    }
    const result = await callTool(
      'read',
      sid,
      `c${HARD_THRESHOLD}`,
      readArgs,
      'file content',
    );
    expect(result).not.toContain('file content');
    expect(result).toContain(LOOP_INTERRUPT_MARKER);
    expect(result).toContain('5th');
  });

  test('different tool call dilutes the window', async () => {
    const sid = 's4';
    // Two identical reads
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      await callTool('read', sid, `c${i}`, readArgs, 'content');
    }
    // Different tool (edit) — adds a different fingerprint to window
    await callTool(
      'edit',
      sid,
      'ce1',
      {
        filePath: '/test/file.ts',
        oldString: 'a',
        newString: 'b',
      },
      'Edit applied',
    );

    // Read again — count is now 3 in window of 4, but the edit diluted
    // so it takes more reads to reach threshold
    const result = await callTool('read', sid, 'cr1', readArgs, 'content');
    // 3 reads in window of 4 → still hits WARN_THRESHOLD
    expect(result).toContain(LOOP_NUDGE_MARKER);
  });

  test('read-after-edit is not a loop', async () => {
    const sid = 's5';
    // read → edit → read (different offset) → edit → read (different offset)
    // Realistic: each read checks a different section after editing
    for (let cycle = 0; cycle < 5; cycle++) {
      const r = await callTool(
        'read',
        sid,
        `r${cycle}`,
        {
          filePath: '/test/file.ts',
          offset: 1 + cycle * 50,
          limit: 50,
        },
        'content',
      );
      expect(r).not.toContain(LOOP_INTERRUPT_MARKER);
      expect(r).not.toContain(LOOP_NUDGE_MARKER);

      const e = await callTool(
        'edit',
        sid,
        `e${cycle}`,
        {
          filePath: '/test/file.ts',
          oldString: `old-${cycle}`,
          newString: `new-${cycle}`,
        },
        'Edit applied',
      );
      expect(e).not.toContain(LOOP_NUDGE_MARKER);
    }
  });

  test('different args on same tool does not trigger', async () => {
    const sid = 's6';
    // read offset=690
    await callTool(
      'read',
      sid,
      'c1',
      { ...readArgs, offset: 690 },
      'content A',
    );
    // read offset=100 — different fingerprint
    await callTool(
      'read',
      sid,
      'c2',
      { ...readArgs, offset: 100 },
      'content B',
    );
    // read offset=200 — different fingerprint
    await callTool(
      'read',
      sid,
      'c3',
      { ...readArgs, offset: 200 },
      'content C',
    );
    // None should trigger — all different fingerprints
    // (each appears only once in window)
  });

  test('per-session isolation', async () => {
    const sidA = 'sA';
    const sidB = 'sB';

    // Session A: 2 identical reads
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      await callTool('read', sidA, `a${i}`, readArgs, 'content');
    }

    // Session B: 2 identical reads — should NOT see session A's window
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      const result = await callTool('read', sidB, `b${i}`, readArgs, 'content');
      expect(result).not.toContain(LOOP_NUDGE_MARKER);
    }
  });

  test('missing sessionID or callID is a no-op', async () => {
    await callBefore('read', '', 'c1', readArgs);
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
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      await callTool('read', sid, `c${i}`, readArgs, 'content');
    }
    const preMarked = `content\n${LOOP_NUDGE_MARKER}\nold nudge`;
    const result = await callTool(
      'read',
      sid,
      `c${WARN_THRESHOLD}`,
      readArgs,
      preMarked,
    );
    const markerCount = result.split(LOOP_NUDGE_MARKER).length - 1;
    expect(markerCount).toBe(1);
  });

  test('clearLoopState removes session tracking', async () => {
    const sid = 's10';
    for (let i = 1; i < WARN_THRESHOLD; i++) {
      await callTool('read', sid, `c${i}`, readArgs, 'content');
    }
    clearLoopState(sid);
    const result = await callTool('read', sid, 'c1fresh', readArgs, 'content');
    expect(result).toBe('content');
    expect(result).not.toContain(LOOP_NUDGE_MARKER);
  });

  test('fingerprint is order-independent for object args', async () => {
    const sid = 's11';
    const argsA = { filePath: '/x.ts', limit: 80, offset: 690 };
    const argsB = { offset: 690, filePath: '/x.ts', limit: 80 };

    await callTool('read', sid, 'c1', argsA, 'content');
    // Same args, different key order — same fingerprint, count=2
    await callTool('read', sid, 'c2', argsB, 'content');
    // count=3 → should nudge
    const result = await callTool('read', sid, 'c3', argsA, 'content');
    expect(result).toContain(LOOP_NUDGE_MARKER);
  });

  test('escalation continues past hard threshold', async () => {
    const sid = 's12';
    for (let i = 1; i <= HARD_THRESHOLD + 3; i++) {
      const result = await callTool(
        'read',
        sid,
        `c${i}`,
        readArgs,
        'file content',
      );
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

  // --- Multi-call cycle tests (the bug we're fixing) ---

  test('2-cycle loop (A→B→A→B→...) is detected', async () => {
    const sid = 's13';
    const cmdA = { command: 'ls /tmp; echo hello' };
    const cmdB = { command: 'find /tmp -maxdepth 1' };

    // Alternate A→B→A→B→... — a simple consecutive detector would miss this
    // because each call is different from the previous one.
    let nudged = false;
    for (let i = 1; i <= 12; i++) {
      const args = i % 2 === 1 ? cmdA : cmdB;
      const result = await callTool('bash', sid, `c${i}`, args, 'output');
      // A appears 3 times at i=5 (calls 1,3,5), 5 times at i=9
      // B appears 3 times at i=6 (calls 2,4,6), 5 times at i=10
      if (result.includes(LOOP_NUDGE_MARKER)) {
        nudged = true;
      }
      if (i >= 5 && i <= 6) {
        expect(nudged).toBe(true);
      }
    }
  });

  test('2-cycle loop escalates to interrupt at hard threshold', async () => {
    const sid = 's14';
    const cmdA = { command: 'ls /tmp' };
    const cmdB = { command: 'find /tmp -maxdepth 1' };

    let interrupted = false;
    for (let i = 1; i <= 12; i++) {
      const args = i % 2 === 1 ? cmdA : cmdB;
      const result = await callTool('bash', sid, `c${i}`, args, 'output');
      // A reaches 5 occurrences at i=9, B at i=10
      if (result.includes(LOOP_INTERRUPT_MARKER)) {
        interrupted = true;
        expect(result).not.toContain('output');
      }
    }
    expect(interrupted).toBe(true);
  });

  test('3-cycle loop (A→B→C→A→B→C→...) is detected', async () => {
    const sid = 's15';
    const cmds = [
      { command: 'ls /a' },
      { command: 'ls /b' },
      { command: 'ls /c' },
    ];

    let nudged = false;
    // 3-cycle: each fingerprint appears 3 times after 9 calls
    for (let i = 1; i <= 12; i++) {
      const args = cmds[(i - 1) % 3];
      const result = await callTool('bash', sid, `c${i}`, args, 'output');
      if (result.includes(LOOP_NUDGE_MARKER)) {
        nudged = true;
      }
    }
    expect(nudged).toBe(true);
  });

  test('window evicts old entries (does not grow unbounded)', async () => {
    const sid = 's16';
    // Fill with unique calls, then verify old ones are evicted
    for (let i = 1; i <= WINDOW_SIZE + 5; i++) {
      await callTool('bash', sid, `c${i}`, { command: `echo ${i}` }, 'output');
    }
    const state = _internals.bySession.get(sid);
    expect(state).toBeDefined();
    expect(state!.window.length).toBeLessThanOrEqual(WINDOW_SIZE);
  });

  test('legitimate varied reads do not trigger', async () => {
    const sid = 's17';
    // Read 10 different files — each fingerprint appears once
    for (let i = 1; i <= 10; i++) {
      const result = await callTool(
        'read',
        sid,
        `c${i}`,
        {
          filePath: `/test/file${i}.ts`,
          offset: 1,
          limit: 50,
        },
        'content',
      );
      expect(result).not.toContain(LOOP_NUDGE_MARKER);
      expect(result).not.toContain(LOOP_INTERRUPT_MARKER);
    }
  });
});
