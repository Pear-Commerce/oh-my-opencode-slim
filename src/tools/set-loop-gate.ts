import { type PluginInput, type ToolDefinition, tool } from '@opencode-ai/plugin';
import { log } from '../utils/logger';
import type { LoopGate } from '../hooks/deepwork-wakeup';

const z = tool.schema;

export interface SetLoopGateToolOptions {
  setGate: (sessionID: string, gate: LoopGate | undefined) => void;
  shouldManageSession: (sessionID: string) => boolean;
}

export function createSetLoopGateTool(
  options: SetLoopGateToolOptions,
): Record<string, ToolDefinition> {
  const set_loop_gate = tool({
    description: `Set a convergence gate for the current deepwork loop.

When set, the periodic wakeup timer runs the gate instead of asking "are you done?"
(useful for "get this passable according to x standard" loops). The gate determines
the loop termination condition:

- **command gate**: runs a shell command. Exit 0 = pass (stop loop), non-zero = fail (continue).
- **adjudicator gate**: spawns a cheap LLM with your prompt. The LLM must respond with
  PASS or FAIL on the first line. Use this for standards that can't be expressed as a
  single command (e.g. "check for blended RVR numbers in prose").

Call with type="clear" to remove the gate and revert to the default yes/no done-check
(checklist/plan mode).

Only callable by orchestrator-class agents in managed sessions.`,
    args: {
      type: z
        .enum(['command', 'adjudicator', 'clear'])
        .describe('Gate type, or "clear" to remove the gate'),
      command: z
        .string()
        .optional()
        .describe('Shell command to run (required when type="command"). Exit 0 = pass.'),
      prompt: z
        .string()
        .optional()
        .describe('Adjudicator prompt (required when type="adjudicator"). The LLM receives this and must respond PASS or FAIL.'),
      model: z
        .string()
        .optional()
        .describe('Model for adjudicator gate (e.g. "openai/gpt-4.1-mini"). Defaults to openai/gpt-4.1-mini.'),
      timeoutMs: z
        .number()
        .optional()
        .describe('Gate execution timeout in ms (default 120000 = 2 min)'),
    },
    async execute(args, toolContext) {
      const sessionID = toolContext?.sessionID;
      if (!sessionID) throw new Error('set_loop_gate requires sessionID');

      if (
        toolContext.agent &&
        toolContext.agent !== 'orchestrator' &&
        !toolContext.agent.startsWith('orchestrator-')
      ) {
        throw new Error('set_loop_gate can only be used by orchestrator');
      }

      if (!options.shouldManageSession(sessionID)) {
        throw new Error(
          'set_loop_gate can only be used in orchestrator sessions',
        );
      }

      if (args.type === 'clear') {
        options.setGate(sessionID, undefined);
        return 'Loop gate cleared. Reverted to default yes/no done-check (checklist mode).';
      }

      if (args.type === 'command') {
        if (!args.command) {
          throw new Error('type="command" requires a "command" argument');
        }
        const gate: LoopGate = {
          type: 'command',
          command: args.command,
          ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        };
        options.setGate(sessionID, gate);
        log('[set_loop_gate] command gate set', { sessionID, command: args.command });
        return `Loop gate set to command: \`${args.command}\`\nThe loop will continue until this command exits 0.`;
      }

      if (args.type === 'adjudicator') {
        if (!args.prompt) {
          throw new Error('type="adjudicator" requires a "prompt" argument');
        }
        const gate: LoopGate = {
          type: 'adjudicator',
          prompt: args.prompt,
          ...(args.model ? { model: args.model } : {}),
          ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
        };
        options.setGate(sessionID, gate);
        log('[set_loop_gate] adjudicator gate set', {
          sessionID,
          model: args.model ?? 'default',
          promptPreview: args.prompt.slice(0, 100),
        });
        return `Loop gate set to LLM adjudicator (model: ${args.model ?? 'openai/gpt-4.1-mini'}).\nThe loop will continue until the adjudicator responds PASS.`;
      }

      throw new Error(`Unknown gate type: ${args.type}`);
    },
  });

  return { set_loop_gate };
}
