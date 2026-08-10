import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
  type CodexSolSessionStore,
  createCodexSolSessionStore,
  createCodexSolTool,
} from './codex-sol';

function context(agent = 'oracle__orchestrator-glm52-sol'): ToolContext {
  return {
    sessionID: 'session-1',
    messageID: 'message-1',
    agent,
    directory: '/workspace/project',
    worktree: '/workspace/project',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function memorySessionStore(): CodexSolSessionStore {
  const sessions = new Map<string, string>();
  return {
    get: async (sessionID) => sessions.get(sessionID),
    set: async (sessionID, codexSessionID) => {
      sessions.set(sessionID, codexSessionID);
    },
  };
}

describe('codex_sol tool', () => {
  test('persists OpenCode-to-Codex thread mappings across store instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-sol-store-'));
    const path = join(directory, 'sessions.json');
    await createCodexSolSessionStore(path).set('opencode-1', 'codex-1');

    expect(await createCodexSolSessionStore(path).get('opencode-1')).toBe(
      'codex-1',
    );
  });

  test('passes captured user text, cwd, model, and high effort to Codex', async () => {
    const runner = mock(async () => ({
      answer: 'Codex answer',
      sessionID: 'codex-thread-1',
    }));
    const command = '/Applications/ChatGPT.app/Contents/Resources/codex';
    const codexSol = createCodexSolTool({
      command,
      runner,
      sessionStore: memorySessionStore(),
      resolvePrompt: () => 'Original user prompt',
    });
    const prompt = 'Review src/index.ts and report the concrete risks.';

    const result = await codexSol.execute({ prompt }, context());

    expect(result).toBe('Codex answer');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toBe('Original user prompt');
    expect(runner.mock.calls[0]?.[1]).toMatchObject({
      command,
      cwd: '/workspace/project',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      sessionID: undefined,
    });
  });

  test('resumes the Codex thread associated with the OpenCode session', async () => {
    const runner = mock(async (_prompt, options) => ({
      answer: options.sessionID ? 'Follow-up answer' : 'First answer',
      sessionID: options.sessionID ?? 'codex-thread-1',
    }));
    const codexSol = createCodexSolTool({
      runner,
      sessionStore: memorySessionStore(),
    });

    expect(await codexSol.execute({ prompt: 'First review' }, context())).toBe(
      'First answer',
    );
    expect(
      await codexSol.execute({ prompt: 'Review the new diff' }, context()),
    ).toBe('Follow-up answer');
    expect(runner.mock.calls[1]?.[1]).toMatchObject({
      sessionID: 'codex-thread-1',
    });
  });

  test('rejects calls from any other agent', async () => {
    const runner = mock(async () => ({ answer: 'unused' }));
    const codexSol = createCodexSolTool({
      runner,
      sessionStore: memorySessionStore(),
    });

    expect(
      codexSol.execute({ prompt: 'review' }, context('orchestrator')),
    ).rejects.toThrow(
      'codex_sol can only be used by oracle__orchestrator-glm52-sol',
    );
    expect(runner).not.toHaveBeenCalled();
  });
});
