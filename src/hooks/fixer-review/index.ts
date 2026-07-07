/**
 * Fixer-review hook — auto-spawn oracle review on non-trivial fixer diffs.
 *
 * When a fixer task completes, this hook measures the working-tree diff. If
 * the change is non-trivial (enough production lines changed or enough
 * production files touched), it spawns an oracle review session as a child
 * of the orchestrator, waits for it to complete, and injects the review
 * result back into the orchestrator via promptAsync.
 *
 * This is a hard mechanism: the review always happens on qualifying fixes,
 * regardless of whether the orchestrator would have asked for it. Simple
 * fixes (typos, small test additions) stay below the threshold and skip the
 * review to avoid wasted oracle calls.
 *
 * The oracle session runs as a fire-and-forget async chain from
 * tool.execute.after — the hook returns immediately and the review proceeds
 * in the background. When it finishes, promptAsync wakes the orchestrator
 * with the review content.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  type PromptBody,
  extractSessionResult,
  log,
  parseModelReference,
  parseTaskLaunchOutput,
  parseTaskStatusOutput,
  promptWithTimeout,
  SLIM_INTERNAL_INITIATOR_MARKER,
} from '../../utils';

const DEFAULT_MIN_PRODUCTION_LINES = 30;
const DEFAULT_MIN_PRODUCTION_FILES = 3;
const DEFAULT_ORACLE_TIMEOUT_MS = 180_000; // 3 min
const DEFAULT_MAX_DIFF_FILES_TO_LIST = 40;

// File patterns that are lower-risk and don't count toward the threshold.
const TEST_OR_DOC_PATTERN =
  /\.(test|spec)\.(ts|js|mjs|cjs|tsx|jsx)$|\.md$|\.txt$|\.jsonc?$|\.ya?ml$|\.gitignore$|\.prettierrc|\.eslintrc|\.biome/i;

interface CapturedFixerCall {
  callID: string;
  sessionID: string;
  description?: string;
  prompt?: string;
}

interface DiffMeasurement {
  totalFiles: number;
  productionFiles: number;
  productionLines: number;
  changedFiles: Array<{ file: string; added: number; deleted: number }>;
}

export interface FixerReviewOptions {
  /** Oracle model string (provider/model). If unset, reviews are skipped. */
  oracleModel?: string;
  /** Project directory for git operations and session creation. */
  directory: string;
  /** Min production lines (non-test, non-doc) to trigger review. */
  minProductionLines?: number;
  /** Min production files to trigger review. */
  minProductionFiles?: number;
  /** Oracle session timeout in ms. */
  oracleTimeoutMs?: number;
  /** Whether the hook is enabled (default true). */
  enabled?: boolean;
}

export function createFixerReviewHook(
  client: PluginInput['client'],
  options: FixerReviewOptions,
) {
  const {
    oracleModel,
    directory,
    minProductionLines = DEFAULT_MIN_PRODUCTION_LINES,
    minProductionFiles = DEFAULT_MIN_PRODUCTION_FILES,
    oracleTimeoutMs = DEFAULT_ORACLE_TIMEOUT_MS,
    enabled = true,
  } = options;

  const capturedCalls = new Map<string, CapturedFixerCall>();

  function measureDiff(): DiffMeasurement | null {
    try {
      // Tracked file changes vs HEAD (modifications, deletions, staged adds)
      const trackedOutput = execSync('git diff --numstat HEAD', {
        cwd: directory,
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Untracked new files (git diff doesn't show these)
      const untrackedOutput = execSync(
        'git ls-files --others --exclude-standard',
        {
          cwd: directory,
          encoding: 'utf-8',
          timeout: 5_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ).trim();

      if (!trackedOutput && !untrackedOutput) return null;

      const changedFiles: DiffMeasurement['changedFiles'] = [];
      let productionFiles = 0;
      let productionLines = 0;

      // Parse tracked changes
      for (const line of trackedOutput.split('\n').filter(Boolean)) {
        const parts = line.split('\t');
        const added = Number(parts[0]);
        const deleted = Number(parts[1]);
        const file = parts.slice(2).join('\t');
        if (!file || Number.isNaN(added) || Number.isNaN(deleted)) continue;

        const isTestOrDoc = TEST_OR_DOC_PATTERN.test(file);
        changedFiles.push({ file, added, deleted });

        if (!isTestOrDoc) {
          productionFiles += 1;
          productionLines += added + deleted;
        }
      }

      // Parse untracked new files — count lines by reading them
      for (const file of untrackedOutput.split('\n').filter(Boolean)) {
        const isTestOrDoc = TEST_OR_DOC_PATTERN.test(file);
        let lineCount = 0;
        try {
          const content = readFileSync(join(directory, file), 'utf-8');
          lineCount = content.split('\n').length - 1; // don't count trailing newline
          if (lineCount < 0) lineCount = 0;
        } catch {
          // Binary or unreadable — count as 1 line to still register the file
          lineCount = 1;
        }

        changedFiles.push({ file, added: lineCount, deleted: 0 });

        if (!isTestOrDoc) {
          productionFiles += 1;
          productionLines += lineCount;
        }
      }

      return {
        totalFiles: changedFiles.length,
        productionFiles,
        productionLines,
        changedFiles,
      };
    } catch (err) {
      log('[fixer-review] git diff failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  function isNonTrivial(diff: DiffMeasurement): boolean {
    return (
      diff.productionLines >= minProductionLines ||
      diff.productionFiles >= minProductionFiles
    );
  }

  function buildOraclePrompt(
    diff: DiffMeasurement,
    fixerDescription?: string,
    fixerPrompt?: string,
  ): string {
    const fileList = diff.changedFiles
      .slice(0, DEFAULT_MAX_DIFF_FILES_TO_LIST)
      .map(
        (f) =>
          `  ${f.file} (+${f.added} -${f.deleted})`,
      )
      .join('\n');

    const truncated =
      diff.changedFiles.length > DEFAULT_MAX_DIFF_FILES_TO_LIST
        ? `\n... and ${diff.changedFiles.length - DEFAULT_MAX_DIFF_FILES_TO_LIST} more`
        : '';

    return [
      'Review a fixer implementation for correctness, edge cases, and simplification.',
      '',
      '## Fixer objective',
      fixerDescription || fixerPrompt?.slice(0, 500) || '(not captured)',
      '',
      '## Changed files (working tree vs HEAD)',
      `${diff.productionFiles} production files, ${diff.productionLines} production lines changed (${diff.totalFiles} total files)`,
      fileList + truncated,
      '',
      '## Review instructions',
      '1. Read each changed production file and review the diff context.',
      '2. Look for: logic errors, missing edge cases, incorrect error handling,',
      '   data integrity risks, and unnecessary complexity.',
      '3. If the change is correct and clean, say "APPROVED" with a one-line reason.',
      '4. If issues are found, list each as: [SEVERITY] file:line — description — fix.',
      '   Severities: BLOCKING, SHOULD-FIX, NIT.',
      '5. Be concise. Do not restate the diff. Focus on what could go wrong.',
    ].join('\n');
  }

  async function spawnOracleReview(
    parentSessionID: string,
    diff: DiffMeasurement,
    fixerDescription?: string,
    fixerPrompt?: string,
  ): Promise<void> {
    if (!oracleModel) {
      log('[fixer-review] oracle model unavailable, skipping review', {
        parentSessionID,
      });
      return;
    }

    const modelRef = parseModelReference(oracleModel);
    if (!modelRef) {
      log('[fixer-review] invalid oracle model format', { oracleModel });
      return;
    }

    const promptText = buildOraclePrompt(diff, fixerDescription, fixerPrompt);
    let oracleSessionId: string | undefined;

    try {
      const session = await client.session.create({
        body: {
          parentID: parentSessionID,
          title: 'Auto oracle review of fixer change',
        },
        query: { directory },
      });

      const sid = (session as { data?: { id?: string } }).data?.id;
      if (!sid) {
        log('[fixer-review] oracle session creation returned no id');
        return;
      }
      oracleSessionId = sid;

      const body: PromptBody = {
        agent: 'oracle',
        model: modelRef,
        tools: { task: false },
        parts: [{ type: 'text', text: promptText }],
      };

      await promptWithTimeout(
        client,
        {
          path: { id: sid },
          body,
          query: { directory },
        },
        oracleTimeoutMs,
      );

      const extraction = await extractSessionResult(client, sid, {
        directory,
        includeReasoning: false,
      });

      if (extraction.empty) {
        log('[fixer-review] oracle returned empty response', {
          oracleSessionId: sid,
        });
        return;
      }

      // Inject the review back into the orchestrator via promptAsync.
      const reviewText = [
        '## Oracle review of fixer change (auto-triggered)',
        '',
        `Reviewed ${diff.productionFiles} production files, ${diff.productionLines} lines changed.`,
        '',
        extraction.text,
        '',
        'Act on any BLOCKING or SHOULD-FIX issues before continuing. If APPROVED, continue normally.',
      ].join('\n');

      const sessionClient = client.session as unknown as {
        promptAsync?: (args: {
          path: { id: string };
          body: {
            parts: Array<{ type: 'text'; text: string }>;
          };
        }) => Promise<unknown>;
      };

      if (typeof sessionClient.promptAsync !== 'function') {
        log('[fixer-review] promptAsync unavailable, cannot inject review', {
          parentSessionID,
        });
        return;
      }

      await sessionClient.promptAsync({
        path: { id: parentSessionID },
        body: {
          parts: [
            {
              type: 'text',
              text: `${reviewText}\n${SLIM_INTERNAL_INITIATOR_MARKER}`,
            },
          ],
        },
      });

      log('[fixer-review] oracle review injected to orchestrator', {
        parentSessionID,
        oracleSessionId: sid,
        productionLines: diff.productionLines,
        productionFiles: diff.productionFiles,
      });
    } catch (err) {
      log('[fixer-review] oracle review failed', {
        parentSessionID,
        oracleSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (oracleSessionId) {
        client.session.abort({ path: { id: oracleSessionId } }).catch(() => {});
      }
    }
  }

  return {
    'tool.execute.before': async (
      input: { tool: string; callID?: string; sessionID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      if (!enabled) return;
      if (input.tool.toLowerCase() !== 'task') return;

      const args = output.args as {
        subagent_type?: unknown;
        description?: unknown;
        prompt?: unknown;
      };
      if (args?.subagent_type !== 'fixer') return;
      if (!input.callID || !input.sessionID) return;

      capturedCalls.set(input.callID, {
        callID: input.callID,
        sessionID: input.sessionID,
        description:
          typeof args.description === 'string' ? args.description : undefined,
        prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
      });
    },

    'tool.execute.after': async (
      input: { tool: string; callID?: string; sessionID?: string },
      output: { output: unknown },
    ): Promise<void> => {
      if (!enabled) return;
      if (input.tool.toLowerCase() !== 'task') return;

      const callID = input.callID;
      if (!callID) return;
      const captured = capturedCalls.get(callID);
      if (captured) capturedCalls.delete(callID);
      if (!captured) return;

      if (typeof output.output !== 'string') return;

      // Skip background launches — only review on foreground completion.
      const launch = parseTaskLaunchOutput(output.output);
      if (launch) return; // background task was launched, not completed yet

      const status = parseTaskStatusOutput(output.output);
      if (!status) return;
      if (status.state !== 'completed') return; // only review successful fixes

      const diff = measureDiff();
      if (!diff || !isNonTrivial(diff)) {
        log('[fixer-review] fixer change below threshold, skipping review', {
          parentSessionID: captured.sessionID,
          productionLines: diff?.productionLines ?? 0,
          productionFiles: diff?.productionFiles ?? 0,
        });
        return;
      }

      log('[fixer-review] non-trivial fixer change detected, spawning oracle', {
        parentSessionID: captured.sessionID,
        productionLines: diff.productionLines,
        productionFiles: diff.productionFiles,
        totalFiles: diff.totalFiles,
      });

      // Fire-and-forget: the review runs in the background and injects its
      // result via promptAsync when done. We do not await this.
      spawnOracleReview(
        captured.sessionID,
        diff,
        captured.description,
        captured.prompt,
      ).catch((err) => {
        log('[fixer-review] unhandled error in review chain', {
          parentSessionID: captured.sessionID,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },

    /** @internal */
    _capturedCalls: capturedCalls,
  };
}
