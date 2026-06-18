import { describe, expect, mock, test } from 'bun:test';
import { createCouncilDetailsHook } from './index';

type CouncillorResult = {
  name: string;
  model: string;
  status: 'completed' | 'failed' | 'timed_out';
  result?: string;
  error?: string;
};

function createMockCouncilManager(
  stashBySession: Record<string, CouncillorResult[]>,
) {
  const cleared = new Set<string>();
  return {
    getStashByParent: mock(
      (parentSessionId: string, childToParent: Map<string, string>) => {
        let best:
          | {
              councilAgentSessionId: string;
              results: { results: CouncillorResult[]; timestamp: number };
            }
          | undefined;
        for (const [sessionId, results] of Object.entries(stashBySession)) {
          if (childToParent.get(sessionId) !== parentSessionId) continue;
          const ts = Number.parseInt(sessionId.replace(/[^0-9]/g, ''), 10) || 0;
          if (!best || ts > best.results.timestamp) {
            best = {
              councilAgentSessionId: sessionId,
              results: { results, timestamp: ts },
            };
          }
        }
        return best;
      },
    ),
    clearStash: mock((sessionId: string) => {
      cleared.add(sessionId);
      delete stashBySession[sessionId];
    }),
    _cleared: cleared,
  };
}

describe('createCouncilDetailsHook', () => {
  describe('tool.execute.before', () => {
    test('records pending call for council task', async () => {
      const manager = createMockCouncilManager({});
      const childToParent = new Map<string, string>();
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      // Verify pending was recorded by observing after behavior.
      const afterOutput = { output: '## Council Response\nsynthesized only' };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        afterOutput,
      );
      // After ran without error → pending was found.
      expect(afterOutput.output).toBeDefined();
    });

    test('ignores non-council task calls', async () => {
      const manager = createMockCouncilManager({});
      const childToParent = new Map<string, string>();
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'explorer' } },
      );

      // No stash, no pending → output unchanged
      const afterOutput = { output: 'explorer result' };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        afterOutput,
      );
      expect(afterOutput.output).toBe('explorer result');
      expect(manager.clearStash).not.toHaveBeenCalled();
    });

    test('ignores non-task tools', async () => {
      const manager = createMockCouncilManager({});
      const childToParent = new Map<string, string>();
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'read', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      const afterOutput = { output: 'file contents' };
      await hook['tool.execute.after'](
        { tool: 'read', sessionID: 'orch-1', callID: 'call-1' },
        afterOutput,
      );
      expect(afterOutput.output).toBe('file contents');
    });
  });

  describe('tool.execute.after', () => {
    test('appends verbatim details when section is missing', async () => {
      const results: CouncillorResult[] = [
        {
          name: 'alpha',
          model: 'openai/gpt-5.4-mini',
          status: 'completed',
          result: 'Alpha says: use option A.',
        },
        {
          name: 'beta',
          model: 'openai/gpt-5.3-codex',
          status: 'completed',
          result: 'Beta says: use option B.',
        },
      ];
      const manager = createMockCouncilManager({
        'council-agent-1': results,
      });
      const childToParent = new Map<string, string>([
        ['council-agent-1', 'orch-1'],
      ]);
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      const output = {
        output:
          '## Council Response\n\nUse option A because it is simpler.\n\n## Council Summary\n\nMajority favored A.',
      };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output,
      );

      expect(output.output).toContain('## Councillor Details (verbatim)');
      expect(output.output).toContain('### alpha (gpt-5.4-mini)');
      expect(output.output).toContain('Alpha says: use option A.');
      expect(output.output).toContain('### beta (gpt-5.3-codex)');
      expect(output.output).toContain('Beta says: use option B.');
      expect(manager.clearStash).toHaveBeenCalledWith('council-agent-1');
    });

    test('appends when section is incomplete (councillor name missing)', async () => {
      const results: CouncillorResult[] = [
        {
          name: 'alpha',
          model: 'openai/gpt-5.4-mini',
          status: 'completed',
          result: 'Alpha full response.',
        },
        {
          name: 'beta',
          model: 'openai/gpt-5.3-codex',
          status: 'completed',
          result: 'Beta full response.',
        },
      ];
      const manager = createMockCouncilManager({
        'council-agent-1': results,
      });
      const childToParent = new Map<string, string>([
        ['council-agent-1', 'orch-1'],
      ]);
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      // Details section present but only mentions alpha, not beta.
      const output = {
        output:
          '## Council Response\n\nSynthesis.\n\n## Councillor Details\n\n### alpha (gpt-5.4-mini)\nAlpha full response.\n\n## Council Summary\n\nDone.',
      };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output,
      );

      expect(output.output).toContain('## Councillor Details (verbatim)');
      expect(output.output).toContain('Beta full response.');
    });

    test('no-op when details section is complete', async () => {
      const results: CouncillorResult[] = [
        {
          name: 'alpha',
          model: 'openai/gpt-5.4-mini',
          status: 'completed',
          result: 'Alpha full response.',
        },
        {
          name: 'beta',
          model: 'openai/gpt-5.3-codex',
          status: 'completed',
          result: 'Beta full response.',
        },
      ];
      const manager = createMockCouncilManager({
        'council-agent-1': results,
      });
      const childToParent = new Map<string, string>([
        ['council-agent-1', 'orch-1'],
      ]);
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      const originalOutput =
        '## Council Response\n\nSynthesis.\n\n## Councillor Details\n\n### alpha (gpt-5.4-mini)\nAlpha full response.\n\n### beta (gpt-5.3-codex)\nBeta full response.\n\n## Council Summary\n\nDone.';
      const output = { output: originalOutput };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output,
      );

      expect(output.output).toBe(originalOutput);
      expect(output.output).not.toContain('verbatim');
      expect(manager.clearStash).toHaveBeenCalledWith('council-agent-1');
    });

    test('no-op when no stash found for parent session', async () => {
      const manager = createMockCouncilManager({
        'council-agent-1': [
          {
            name: 'alpha',
            model: 'openai/gpt-5.4-mini',
            status: 'completed',
            result: 'Alpha response.',
          },
        ],
      });
      // childToParent does NOT map council-agent-1 to orch-1
      const childToParent = new Map<string, string>([
        ['council-agent-1', 'other-orchestrator'],
      ]);
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      const output = { output: '## Council Response\nOnly synthesis.' };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output,
      );

      expect(output.output).toBe('## Council Response\nOnly synthesis.');
      expect(manager.clearStash).not.toHaveBeenCalled();
    });

    test('no-op when no pending call recorded', async () => {
      const manager = createMockCouncilManager({
        'council-agent-1': [
          {
            name: 'alpha',
            model: 'openai/gpt-5.4-mini',
            status: 'completed',
            result: 'Alpha response.',
          },
        ],
      });
      const childToParent = new Map<string, string>([
        ['council-agent-1', 'orch-1'],
      ]);
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      // No tool.execute.before call — directly call after.
      const output = { output: '## Council Response\nOnly synthesis.' };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output,
      );

      expect(output.output).toBe('## Council Response\nOnly synthesis.');
    });

    test('no-op when output is not a string', async () => {
      const manager = createMockCouncilManager({
        'council-agent-1': [
          {
            name: 'alpha',
            model: 'openai/gpt-5.4-mini',
            status: 'completed',
            result: 'Alpha response.',
          },
        ],
      });
      const childToParent = new Map<string, string>([
        ['council-agent-1', 'orch-1'],
      ]);
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      const output: { output?: unknown } = { output: { not: 'a string' } };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output,
      );

      expect(output.output).toEqual({ not: 'a string' });
    });

    test('renders failed councillors with status in verbatim section', async () => {
      const results: CouncillorResult[] = [
        {
          name: 'alpha',
          model: 'openai/gpt-5.4-mini',
          status: 'completed',
          result: 'Alpha response.',
        },
        {
          name: 'beta',
          model: 'openai/gpt-5.3-codex',
          status: 'timed_out',
          error: 'Timed out after 180000ms',
        },
      ];
      const manager = createMockCouncilManager({
        'council-agent-1': results,
      });
      const childToParent = new Map<string, string>([
        ['council-agent-1', 'orch-1'],
      ]);
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      const output = { output: '## Council Response\nSynthesis only.' };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output,
      );

      expect(output.output).toContain('### beta (gpt-5.3-codex)');
      expect(output.output).toContain(
        '**timed_out** — Timed out after 180000ms',
      );
    });

    test('pending call is cleared after processing', async () => {
      const results: CouncillorResult[] = [
        {
          name: 'alpha',
          model: 'openai/gpt-5.4-mini',
          status: 'completed',
          result: 'Alpha response.',
        },
      ];
      const manager = createMockCouncilManager({
        'council-agent-1': results,
      });
      const childToParent = new Map<string, string>([
        ['council-agent-1', 'orch-1'],
      ]);
      const hook = createCouncilDetailsHook(manager as any, childToParent);

      await hook['tool.execute.before'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        { args: { subagent_type: 'council' } },
      );

      const output1 = { output: '## Council Response\nSynthesis.' };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output1,
      );
      // First call appended verbatim details.
      expect(output1.output).toContain('## Councillor Details (verbatim)');

      // Second after call with same callID — pending already cleared,
      // so it should be a no-op even with a fresh output.
      const output2 = { output: '## Council Response\nSecond synthesis.' };
      await hook['tool.execute.after'](
        { tool: 'task', sessionID: 'orch-1', callID: 'call-1' },
        output2,
      );
      expect(output2.output).toBe('## Council Response\nSecond synthesis.');
    });
  });
});
