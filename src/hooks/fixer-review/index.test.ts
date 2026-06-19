import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createFixerReviewHook } from './index';

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function writeFile(filePath: string, content: string): void {
  ensureDir(filePath);
  writeFileSync(filePath, content);
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fixer-review-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@test.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
  // initial commit so HEAD exists
  writeFileSync(join(dir, 'README.md'), 'init\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

function makeClient() {
  const create = mock(async () => ({ data: { id: 'ses_ora_review' } }));
  const prompt = mock(async () => {});
  const promptAsync = mock(async () => {});
  const abort = mock(async () => {});
  const messages = mock(async () => ({
    data: [
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'APPROVED. Change is correct.' }],
      },
    ],
  }));
  const client = {
    session: { create, prompt, promptAsync, abort, messages },
  } as unknown as Parameters<typeof createFixerReviewHook>[0];
  return { client, create, prompt, promptAsync, abort, messages };
}

const COMPLETED_OUTPUT = [
  'task_id: ses_fixer1',
  'state: completed',
  '',
  '<task_result>',
  'Fix applied successfully.',
  '</task_result>',
].join('\n');

const ERROR_OUTPUT = [
  'task_id: ses_fixer1',
  'state: error',
  '',
  '<task_error>',
  'something broke',
  '</task_error>',
].join('\n');

const LAUNCH_OUTPUT = [
  'task_id: ses_fixer1',
  'state: running',
  '',
  'Background task launched.',
].join('\n');

describe('fixer-review hook', () => {
  test('spawns oracle review on non-trivial production change', async () => {
    const dir = makeGitRepo();
    // 40-line production change in 1 file → exceeds minProductionLines (30)
    writeFile(
      join(dir, 'src/server/logic.js'),
      Array.from({ length: 40 }, (_, i) => `function fn${i}() { return ${i}; }`).join('\n') + '\n',
    );

    const { client, create, promptAsync } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
      oracleTimeoutMs: 1000,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer', description: 'Fix the bug' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    // Fire-and-forget — give it a moment to run
    await new Promise((r) => setTimeout(r, 50));

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].body.parentID).toBe('ses_orch');
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0].path.id).toBe('ses_orch');
    const reviewText = promptAsync.mock.calls[0]?.[0].body.parts[0].text;
    expect(reviewText).toContain('Oracle review of fixer change');
    expect(reviewText).toContain('APPROVED');
  });

  test('does not spawn review for trivial change (below threshold)', async () => {
    const dir = makeGitRepo();
    // 5-line production change → below threshold
    writeFile(
      join(dir, 'src/server/logic.js'),
      'function fn1() { return 1; }\nfunction fn2() { return 2; }\n',
    );

    const { client, create, promptAsync } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer', description: 'typo fix' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
  });

  test('does not count test/doc files toward threshold', async () => {
    const dir = makeGitRepo();
    // 100-line test file change → should NOT trigger (test files excluded)
    writeFile(
      join(dir, 'tests/logic.test.js'),
      Array.from({ length: 100 }, (_, i) => `test('test${i}', () => {});`).join('\n') + '\n',
    );

    const { client, create } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).not.toHaveBeenCalled();
  });

  test('triggers on many production files even if each is small', async () => {
    const dir = makeGitRepo();
    mkdirSync(join(dir, 'src'), { recursive: true });
    // 4 production files, 3 lines each → exceeds minProductionFiles (3)
    for (let i = 0; i < 4; i++) {
      writeFile(join(dir, `src/file${i}.js`), `a\nb\nc\n`);
    }

    const { client, create } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).toHaveBeenCalledTimes(1);
  });

  test('does not spawn review on fixer error', async () => {
    const dir = makeGitRepo();
    writeFile(join(dir, 'src/server/logic.js'), 'x'.repeat(100) + '\n');

    const { client, create } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: ERROR_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).not.toHaveBeenCalled();
  });

  test('does not spawn review on background launch (only on completion)', async () => {
    const dir = makeGitRepo();
    writeFile(join(dir, 'src/server/logic.js'), 'x'.repeat(100) + '\n');

    const { client, create } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: LAUNCH_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).not.toHaveBeenCalled();
  });

  test('ignores non-fixer task completions', async () => {
    const dir = makeGitRepo();
    writeFile(join(dir, 'src/server/logic.js'), 'x'.repeat(100) + '\n');

    const { client, create } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'explorer' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).not.toHaveBeenCalled();
  });

  test('skips review when oracle model is not configured', async () => {
    const dir = makeGitRepo();
    writeFile(join(dir, 'src/server/logic.js'), 'x'.repeat(100) + '\n');

    const { client, create } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: undefined,
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).not.toHaveBeenCalled();
  });

  test('disabled hook does nothing', async () => {
    const dir = makeGitRepo();
    writeFile(join(dir, 'src/server/logic.js'), 'x'.repeat(100) + '\n');

    const { client, create } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
      enabled: false,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).not.toHaveBeenCalled();
  });

  test('cleans up captured calls after processing', async () => {
    const dir = makeGitRepo();
    writeFile(join(dir, 'src/server/logic.js'), 'x'.repeat(100) + '\n');

    const { client } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer' } },
    );

    const captured = (hook as unknown as { _capturedCalls: Map<string, unknown> })._capturedCalls;
    expect(captured.has('call1')).toBe(true);

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    expect(captured.has('call1')).toBe(false);
  });

  test('handles git diff failure gracefully (fail open)', async () => {
    // Non-git directory → git diff fails
    const dir = mkdtempSync(join(tmpdir(), 'fixer-review-nogit-'));

    const { client, create } = makeClient();
    const hook = createFixerReviewHook(client, {
      oracleModel: 'openrouter/anthropic/claude-opus-4.8',
      directory: dir,
    });

    await hook['tool.execute.before'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { args: { subagent_type: 'fixer' } },
    );

    await hook['tool.execute.after'](
      { tool: 'task', callID: 'call1', sessionID: 'ses_orch' },
      { output: COMPLETED_OUTPUT },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(create).not.toHaveBeenCalled();
  });
});
