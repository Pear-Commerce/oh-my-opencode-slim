import { describe, expect, mock, test } from 'bun:test';
import type { ToolContext } from '@opencode-ai/plugin';
import { createCodexSolTool } from './codex-sol';

function context(agent = 'orchestrator-glm52-sol'): ToolContext {
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

describe('codex_sol tool', () => {
  test('passes the exact prompt and session directory to Codex', async () => {
    const runner = mock(async () => 'Codex answer');
    const command = '/Applications/ChatGPT.app/Contents/Resources/codex';
    const codexSol = createCodexSolTool({ command, runner });
    const prompt = 'Review src/index.ts and report the concrete risks.';

    const result = await codexSol.execute({ prompt }, context());

    expect(result).toBe('Codex answer');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0]).toBe(prompt);
    expect(runner.mock.calls[0]?.[1]).toMatchObject({
      command,
      cwd: '/workspace/project',
      model: 'gpt-5.6-sol',
    });
  });

  test('rejects calls from any other agent', async () => {
    const runner = mock(async () => 'unused');
    const codexSol = createCodexSolTool({ runner });

    expect(
      codexSol.execute({ prompt: 'review' }, context('orchestrator')),
    ).rejects.toThrow('codex_sol can only be used by orchestrator-glm52-sol');
    expect(runner).not.toHaveBeenCalled();
  });
});
