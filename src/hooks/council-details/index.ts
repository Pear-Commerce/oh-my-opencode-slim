/**
 * Council Details Hook
 *
 * Deterministically ensures verbatim per-councillor responses appear in
 * the `task` tool output when `subagent_type === 'council'`.
 *
 * Problem: the council agent's built-in prompt asks it to include a
 * `## Councillor Details` section, but for long or significant responses
 * the LLM frequently trims or omits that section, returning only the
 * synthesized `## Council Response`. Prompt-only enforcement is
 * probabilistic.
 *
 * Solution: `CouncilManager` stashes the raw councillor results keyed by
 * the council agent session. This hook correlates a `task` tool call
 * (parent = orchestrator session) with the council agent session it
 * spawned via the plugin-level `childToParent` map (populated on
 * `session.created` events). After the `task` tool returns the council
 * agent's final message, the hook checks whether the message contains a
 * complete `## Councillor Details` section. If not, it appends a
 * verbatim block built from the stashed results — guaranteeing the user
 * always sees who-said-what, regardless of LLM trimming.
 */

import {
  formatCouncillorDetailsSection,
  hasCompleteCouncillorDetails,
} from '../../agents/council';
import type { CouncilManager } from '../../council/council-manager';
import { log } from '../../utils/logger';

interface ToolExecuteBeforeInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolExecuteBeforeOutput {
  args?: unknown;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
}

interface ToolExecuteAfterOutput {
  output?: unknown;
}

interface TaskArgs {
  subagent_type?: unknown;
}

interface PendingCall {
  callId: string;
  parentSessionId: string;
}

function pendingCallId(callID?: string, sessionID?: string): string {
  return `${callID ?? 'unknown'}:${sessionID ?? 'unknown'}`;
}

export function createCouncilDetailsHook(
  councilManager: CouncilManager,
  childToParent: Map<string, string>,
) {
  // Pending task calls with subagent_type === 'council', keyed by
  // callID+sessionID. Populated in tool.execute.before, consumed in
  // tool.execute.after. Capped to avoid unbounded growth on pathological
  // tool-call patterns.
  const pendingCalls = new Map<string, PendingCall>();
  const MAX_PENDING = 100;

  function rememberPending(call: PendingCall): void {
    if (pendingCalls.size >= MAX_PENDING) {
      const oldest = pendingCalls.keys().next().value;
      if (oldest !== undefined) pendingCalls.delete(oldest);
    }
    pendingCalls.set(pendingCallId(call.callId, call.parentSessionId), call);
  }

  function takePending(
    callID?: string,
    sessionID?: string,
  ): PendingCall | undefined {
    return pendingCalls.get(pendingCallId(callID, sessionID));
  }

  function clearPending(callID?: string, sessionID?: string): void {
    pendingCalls.delete(pendingCallId(callID, sessionID));
  }

  return {
    'tool.execute.before': async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'task') return;
      if (!input.sessionID) return;

      const args = output.args as TaskArgs | undefined;
      if (!args || args.subagent_type !== 'council') return;

      rememberPending({
        callId: input.callID ?? 'unknown',
        parentSessionId: input.sessionID,
      });
    },

    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'task') return;

      const pending = takePending(input.callID, input.sessionID);
      clearPending(input.callID, input.sessionID);
      if (!pending) return;

      if (typeof output.output !== 'string') return;
      const currentOutput = output.output;

      // Locate the stashed councillor results for the council agent
      // session that this task call spawned. Correlation is via the
      // plugin-level childToParent map: the council agent session is a
      // child of the orchestrator session (pending.parentSessionId).
      const stash = councilManager.getStashByParent(
        pending.parentSessionId,
        childToParent,
      );

      if (!stash) {
        // No stash found — council may have failed before stashing, or
        // the session correlation missed (e.g. session.created event
        // not yet processed). Nothing deterministic we can do; leave the
        // council agent's output as-is.
        log('[council-details] no stash found for parent session', {
          parentSessionId: pending.parentSessionId,
        });
        return;
      }

      const { councilAgentSessionId, results } = stash;

      if (hasCompleteCouncillorDetails(currentOutput, results.results)) {
        // Council agent already included full per-councillor details.
        // No-op to avoid duplication.
        councilManager.clearStash(councilAgentSessionId);
        return;
      }

      // Details missing or incomplete — append the verbatim block.
      const verbatimSection = formatCouncillorDetailsSection(results.results);
      output.output = `${currentOutput}\n\n---\n\n${verbatimSection}`;

      log('[council-details] appended verbatim councillor details', {
        parentSessionId: pending.parentSessionId,
        councilAgentSessionId,
        councillorCount: results.results.length,
      });

      councilManager.clearStash(councilAgentSessionId);
    },
  };
}
