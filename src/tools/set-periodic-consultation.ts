import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { log } from '../utils/logger';
import type { PeriodicConsultation } from '../hooks/deepwork-wakeup';

const z = tool.schema;

export interface SetPeriodicConsultationToolOptions {
  setConsultation: (
    sessionID: string,
    consultation: PeriodicConsultation | undefined,
  ) => void;
  shouldManageSession: (sessionID: string) => boolean;
  /**
   * Async fallback when shouldManageSession returns false (e.g. post-restart
   * with empty sessionAgentMap). See set-loop-gate.ts for the same pattern.
   */
  shouldManageSessionAsync?: (sessionID: string) => Promise<boolean>;
}

export function createSetPeriodicConsultationTool(
  options: SetPeriodicConsultationToolOptions,
): Record<string, ToolDefinition> {
  const set_periodic_consultation = tool({
    description: `Set a periodic consultation ("babysitter") that fires every X minutes.

Every \`intervalMinutes\`, the hook sends the orchestrator a prompt to delegate to its
Oracle specialist via the task tool (desktop-visible, clickable subagent). The Oracle
reviews progress and advises; the orchestrator continues with the feedback. No PASS/FAIL,
no loop termination — just periodic consultation.

Different from a convergence gate (set_loop_gate): a gate is a convergence loop (keep
going until PASS), a consultation is a periodic check-in (every X minutes, get advice).
They can coexist: gate handles termination, consultation handles periodic check-ins.

If the orchestrator is busy when the timer fires, the consultation is queued and fires
when the orchestrator goes idle (no skipped check-ins).

Persists to disk so it survives process restarts. Call with no args (or intervalMinutes=0)
to clear.

Only callable by orchestrator-class agents in managed sessions.`,
    args: {
      prompt: z
        .string()
        .optional()
        .describe('The prompt to send to the Oracle every interval. Required to set a consultation.'),
      intervalMinutes: z
        .number()
        .min(1)
        .optional()
        .describe('Fire every N minutes. Required to set. Pass 0 or omit to clear.'),
      files: z
        .array(z.string())
        .optional()
        .describe('File paths for the Oracle to read as part of its review (passed as paths in the prompt).'),
      clear: z
        .boolean()
        .optional()
        .describe('Pass true to clear the consultation (alternative to omitting intervalMinutes).'),
    },
    async execute(args, toolContext) {
      const sessionID = toolContext?.sessionID;
      if (!sessionID) throw new Error('set_periodic_consultation requires sessionID');

      if (
        toolContext.agent &&
        toolContext.agent !== 'orchestrator' &&
        !toolContext.agent.startsWith('orchestrator-')
      ) {
        throw new Error('set_periodic_consultation can only be used by orchestrator');
      }

      // Clear request
      if (args.clear === true || !args.intervalMinutes || args.intervalMinutes < 1) {
        options.setConsultation(sessionID, undefined);
        log('[set_periodic_consultation] consultation cleared', { sessionID });
        return 'Periodic consultation cleared.';
      }

      if (!args.prompt) {
        throw new Error('set_periodic_consultation requires a "prompt" argument');
      }

      // shouldManageSession check (with async fallback for post-restart)
      if (!options.shouldManageSession(sessionID)) {
        if (options.shouldManageSessionAsync) {
          const managed = await options.shouldManageSessionAsync(sessionID);
          if (!managed) {
            throw new Error(
              'set_periodic_consultation can only be used in orchestrator sessions',
            );
          }
        } else {
          throw new Error(
            'set_periodic_consultation can only be used in orchestrator sessions',
          );
        }
      }

      const consultation: PeriodicConsultation = {
        prompt: args.prompt,
        intervalMinutes: args.intervalMinutes,
        ...(args.files ? { files: args.files } : {}),
      };

      options.setConsultation(sessionID, consultation);
      log('[set_periodic_consultation] consultation set', {
        sessionID,
        intervalMinutes: consultation.intervalMinutes,
        fileCount: args.files?.length ?? 0,
        promptPreview: args.prompt.slice(0, 100),
      });

      const fileNote = args.files?.length
        ? ` with ${args.files.length} file path(s) for the oracle to read`
        : '';
      return `Periodic consultation set: every ${args.intervalMinutes} minutes${fileNote}.\nThe Oracle will review progress and advise. The consultation is queued if the orchestrator is busy.`;
    },
  });

  return { set_periodic_consultation };
}
