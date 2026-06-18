/**
 * Council Manager
 *
 * Orchestrates multi-LLM council sessions: launches councillors in
 * parallel and collects their results for the council agent to synthesize.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import {
  formatCouncillorPrompt,
  formatCouncillorResults,
} from '../agents/council';
import type { PluginConfig } from '../config';
import {
  COUNCILLOR_STAGGER_MS,
  TMUX_SPAWN_DELAY_MS,
} from '../config/constants';
import type { CouncillorConfig, CouncilResult } from '../config/council-schema';
import { log } from '../utils/logger';
import {
  extractSessionResult,
  type PromptBody,
  parseModelReference,
  promptWithTimeout,
  shortModelLabel,
} from '../utils/session';
import type { SubagentDepthTracker } from '../utils/subagent-depth';

type OpencodeClient = PluginInput['client'];

// ---------------------------------------------------------------------------
// File attachment helper
// ---------------------------------------------------------------------------

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  md: 'text/markdown',
  html: 'text/html',
  xml: 'application/xml',
  zip: 'application/zip',
};

/**
 * Read a file from disk and build a native file part (data URL) for the
 * session prompt body. Returns null if the file can't be read — never throws.
 */
function buildFilePart(filePath: string): {
  type: 'file';
  mime: string;
  filename: string;
  url: string;
} | null {
  try {
    const bytes = readFileSync(filePath);
    const ext = (filePath.split('.').pop() ?? '').toLowerCase();
    const mime = MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
    const b64 = Buffer.from(bytes).toString('base64');
    return {
      type: 'file',
      mime,
      filename: basename(filePath),
      url: `data:${mime};base64,${b64}`,
    };
  } catch (error) {
    log('[council-manager] Failed to read file for councillor attachment', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// CouncilManager
// ---------------------------------------------------------------------------

type StashedResults = {
  results: CouncilResult['councillorResults'];
  timestamp: number;
};

// Upper bound on retained stashes. Each entry holds the raw councillor
// responses for one council session, so we cap to avoid unbounded growth
// under heavy use. Eviction is oldest-first.
const MAX_STASHED_SESSIONS = 50;

export class CouncilManager {
  private client: OpencodeClient;
  private directory: string;
  private config?: PluginConfig;
  private depthTracker?: SubagentDepthTracker;
  private tmuxEnabled: boolean;
  private deprecatedFields?: string[];
  private legacyMasterModel?: string;

  /**
   * Stashes the raw councillor results from the most recent `runCouncil`
   * call, keyed by the council agent session ID (the `parentSessionId`
   * passed to `runCouncil`). Consumed by the council-details hook to
   * deterministically re-append verbatim per-councillor details if the
   * council agent trimmed them from its final message.
   */
  private stashByCouncilSession = new Map<string, StashedResults>();

  constructor(
    ctx: PluginInput,
    config?: PluginConfig,
    depthTracker?: SubagentDepthTracker,
    tmuxEnabled = false,
  ) {
    this.client = ctx.client;
    this.directory = ctx.directory;
    this.config = config;
    this.deprecatedFields = config?.council?._deprecated;
    this.legacyMasterModel = config?.council?._legacyMasterModel;
    this.depthTracker = depthTracker;
    this.tmuxEnabled = tmuxEnabled;
  }

  /** Return deprecated config fields detected during parsing (for tool warnings). */
  getDeprecatedFields(): string[] | undefined {
    return this.deprecatedFields;
  }

  /** Return the legacy master.model if it was used as fallback. */
  getLegacyMasterModel(): string | undefined {
    return this.legacyMasterModel;
  }

  /**
   * Retrieve stashed councillor results for a council agent session.
   * Returns undefined when no stash exists (e.g. session never ran a
   * council, or stash was already consumed/cleared).
   */
  getStash(councilAgentSessionId: string): StashedResults | undefined {
    return this.stashByCouncilSession.get(councilAgentSessionId);
  }

  /**
   * Find the most recently stashed council results whose council agent
   * session is a child of `parentSessionId`. Used by the council-details
   * hook to correlate a `task` tool call (parent = orchestrator) with the
   * council agent session it spawned, without requiring opencode to expose
   * the child session ID on the task tool output.
   *
   * `childToParent` is the plugin-level session.parent map maintained on
   * `session.created` events.
   */
  getStashByParent(
    parentSessionId: string,
    childToParent: Map<string, string>,
  ): { councilAgentSessionId: string; results: StashedResults } | undefined {
    let best:
      | { councilAgentSessionId: string; results: StashedResults }
      | undefined;
    for (const [sessionId, results] of this.stashByCouncilSession) {
      if (childToParent.get(sessionId) !== parentSessionId) continue;
      if (!best || results.timestamp > best.results.timestamp) {
        best = { councilAgentSessionId: sessionId, results };
      }
    }
    return best;
  }

  /** Remove a stashed entry (e.g. after the details hook consumed it). */
  clearStash(councilAgentSessionId: string): void {
    this.stashByCouncilSession.delete(councilAgentSessionId);
  }

  /**
   * Stash councillor results keyed by the council agent session. Evicts
   * the oldest entry when the cap is reached.
   */
  private stashResults(
    councilAgentSessionId: string,
    results: CouncilResult['councillorResults'],
  ): void {
    if (this.stashByCouncilSession.size >= MAX_STASHED_SESSIONS) {
      // Map iteration is insertion-ordered; first entry is oldest.
      const oldest = this.stashByCouncilSession.keys().next().value;
      if (oldest !== undefined) this.stashByCouncilSession.delete(oldest);
    }
    this.stashByCouncilSession.set(councilAgentSessionId, {
      results,
      timestamp: Date.now(),
    });
  }

  /**
   * Run a full council session.
   *
   * 1. Look up the preset
   * 2. Launch all councillors in parallel
   * 3. Collect results (respecting timeout)
   * 4. Return formatted councillor results for synthesis
   */
  async runCouncil(
    prompt: string,
    presetName: string | undefined,
    parentSessionId: string,
    files?: string[],
  ): Promise<CouncilResult> {
    // Check depth limit before starting councillors
    if (this.depthTracker) {
      const parentDepth = this.depthTracker.getDepth(parentSessionId);
      if (parentDepth + 1 > this.depthTracker.maxDepth) {
        log('[council-manager] spawn blocked: max depth exceeded', {
          parentSessionId,
          parentDepth,
          maxDepth: this.depthTracker.maxDepth,
        });
        return {
          success: false,
          error: 'Subagent depth exceeded',
          councillorResults: [],
        };
      }
    }

    const councilConfig = this.config?.council;
    if (!councilConfig) {
      log('[council-manager] Council configuration not found');
      return {
        success: false,
        error: 'Council not configured',
        councillorResults: [],
      };
    }

    const resolvedPreset =
      presetName ?? councilConfig.default_preset ?? 'default';
    const preset = councilConfig.presets[resolvedPreset];

    if (!preset) {
      const available = Object.keys(councilConfig.presets).join(', ');
      log(`[council-manager] Preset "${resolvedPreset}" not found`);
      return {
        success: false,
        error: `Preset "${resolvedPreset}" does not exist. Omit the preset parameter to use the default, or call again with one of: ${available}`,
        councillorResults: [],
      };
    }

    if (Object.keys(preset).length === 0) {
      log(`[council-manager] Preset "${resolvedPreset}" has no councillors`);
      return {
        success: false,
        error: `Preset "${resolvedPreset}" has no councillors configured. Note: the reserved key "master" is ignored — use councillor names as keys`,
        councillorResults: [],
      };
    }

    const timeout = councilConfig.timeout ?? 180000;
    const executionMode = councilConfig.councillor_execution_mode ?? 'parallel';
    const maxRetries = councilConfig.councillor_retries ?? 3;

    const councillorCount = Object.keys(preset).length;

    log(`[council-manager] Starting council with preset "${resolvedPreset}"`, {
      councillors: Object.keys(preset),
    });

    // Notify parent session that council is starting
    this.sendStartNotification(parentSessionId, councillorCount).catch(
      (err) => {
        log('[council-manager] Failed to send start notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );

    // Run councillors (parallel or serial based on config)
    const councillorResults = await this.runCouncillors(
      prompt,
      preset,
      parentSessionId,
      timeout,
      executionMode,
      maxRetries,
      files,
    );

    // Stash raw councillor results so the council-details hook can
    // deterministically re-append verbatim per-councillor details if the
    // council agent trims them from its final message. Stash on every
    // run (including partial/total failure) so failed councillors are
    // also surfaced verbatim.
    this.stashResults(parentSessionId, councillorResults);

    const completedCount = councillorResults.filter(
      (r) => r.status === 'completed',
    ).length;

    log(
      `[council-manager] Councillors completed: ${completedCount}/${councillorResults.length}`,
    );

    if (completedCount === 0) {
      return {
        success: false,
        error: 'All councillors failed or timed out',
        councillorResults,
      };
    }

    // Format councillor results for the council agent to synthesize
    const formattedCouncillorResults = formatCouncillorResults(
      prompt,
      councillorResults,
    );

    log('[council-manager] Council completed successfully');

    return {
      success: true,
      result: formattedCouncillorResults,
      councillorResults,
    };
  }

  // -------------------------------------------------------------------------
  // Parent session notification
  // -------------------------------------------------------------------------

  /**
   * Inject a start notification into the parent session so the user
   * sees immediate feedback while councillors are spinning up.
   */
  private async sendStartNotification(
    parentSessionId: string,
    councillorCount: number,
  ): Promise<void> {
    const message = [
      `⎔ Council starting — ${councillorCount} councillors launching — ctrl+x ↓ to watch`,
      '',
      '[system status: continue without acknowledging this notification]',
    ].join('\n');
    await this.client.session.prompt({
      path: { id: parentSessionId },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: message }],
      },
    });
  }

  // -------------------------------------------------------------------------
  // Shared session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Run a single agent session: create → register → prompt → extract → cleanup.
   */
  private async runAgentSession(options: {
    parentSessionId: string;
    title: string;
    agent: string;
    model: string;
    promptText: string;
    variant?: string;
    timeout: number;
    includeReasoning?: boolean;
    files?: string[];
  }): Promise<string> {
    const modelRef = parseModelReference(options.model);
    if (!modelRef) {
      throw new Error(`Invalid model format: ${options.model}`);
    }

    let sessionId: string | undefined;

    try {
      const session = await this.client.session.create({
        body: {
          parentID: options.parentSessionId,
          title: options.title,
        },
        query: { directory: this.directory },
      });

      if (!session.data?.id) {
        throw new Error('Failed to create session');
      }

      sessionId = session.data.id;

      if (this.depthTracker) {
        const registered = this.depthTracker.registerChild(
          options.parentSessionId,
          sessionId,
        );
        if (!registered) {
          throw new Error('Subagent depth exceeded');
        }
      }

      if (this.tmuxEnabled) {
        await new Promise((r) => setTimeout(r, TMUX_SPAWN_DELAY_MS));
      }

      const body: PromptBody = {
        agent: options.agent,
        model: modelRef,
        tools: { task: false },
        parts: [{ type: 'text', text: options.promptText }],
      };

      if (options.variant) {
        body.variant = options.variant;
      }

      // Attach user-uploaded files (passed through from council_session) as
      // native file parts so each councillor can see their contents.
      if (options.files && options.files.length > 0) {
        for (const filePath of options.files) {
          const filePart = buildFilePart(filePath);
          if (filePart) {
            body.parts.push(filePart);
          }
        }
      }

      await promptWithTimeout(
        this.client,
        {
          path: { id: sessionId },
          body,
          query: { directory: this.directory },
        },
        options.timeout,
      );

      const extraction = await extractSessionResult(this.client, sessionId, {
        includeReasoning: options.includeReasoning,
      });

      if (extraction.empty) {
        const retryOnEmpty = this.config?.fallback?.retry_on_empty ?? true;
        if (retryOnEmpty) {
          throw new Error('Empty response from provider');
        }
      }

      return extraction.text;
    } finally {
      if (sessionId) {
        this.client.session.abort({ path: { id: sessionId } }).catch(() => {});
        if (this.depthTracker) {
          this.depthTracker.cleanup(sessionId);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 1: Councillors
  // -------------------------------------------------------------------------

  private async runCouncillors(
    prompt: string,
    councillors: Record<string, CouncillorConfig>,
    parentSessionId: string,
    timeout: number,
    executionMode: 'parallel' | 'serial' = 'parallel',
    maxRetries: number,
    files?: string[],
  ): Promise<CouncilResult['councillorResults']> {
    const entries = Object.entries(councillors);
    const results: Array<{
      name: string;
      model: string;
      status: 'completed' | 'failed' | 'timed_out';
      result?: string;
      error?: string;
    }> = [];

    if (executionMode === 'serial') {
      // Serial execution: run each councillor one at a time
      for (const [name, config] of entries) {
        results.push(
          await this.runCouncillorWithRetry(
            name,
            config,
            prompt,
            parentSessionId,
            timeout,
            maxRetries,
            files,
          ),
        );
      }
    } else {
      // Parallel execution (default): run all councillors concurrently
      const promises = entries.map(([name, config], index) =>
        (async () => {
          // Stagger launches only when multiplexer panes can be created.
          // Outside tmux/zellij this delay only adds latency with no benefit.
          if (this.tmuxEnabled && index > 0) {
            await new Promise((r) =>
              setTimeout(r, index * COUNCILLOR_STAGGER_MS),
            );
          }

          return this.runCouncillorWithRetry(
            name,
            config,
            prompt,
            parentSessionId,
            timeout,
            maxRetries,
            files,
          );
        })(),
      );

      const settled = await Promise.allSettled(promises);

      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        const [name, cfg] = entries[index];

        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            name,
            model: cfg.model,
            status: 'failed' as const,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
        }
      }
    }

    return results;
  }

  /**
   * Run a single councillor with retry logic for empty responses.
   * Only retries on "Empty response from provider" errors — timeouts
   * and other failures are returned immediately.
   */
  private async runCouncillorWithRetry(
    name: string,
    config: CouncillorConfig,
    prompt: string,
    parentSessionId: string,
    timeout: number,
    maxRetries: number,
    files?: string[],
  ): Promise<{
    name: string;
    model: string;
    status: 'completed' | 'failed' | 'timed_out';
    result?: string;
    error?: string;
  }> {
    const modelLabel = shortModelLabel(config.model);
    const totalAttempts = 1 + maxRetries;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (attempt > 1) {
        log(
          `[council-manager] Retrying councillor "${name}" (${modelLabel}), attempt ${attempt}/${totalAttempts}`,
        );
      }

      try {
        const result = await this.runAgentSession({
          parentSessionId,
          title: `Council ${name} (${modelLabel})`,
          agent: 'councillor',
          model: config.model,
          promptText: formatCouncillorPrompt(prompt, config.prompt),
          variant: config.variant,
          timeout,
          includeReasoning: false,
          files,
        });

        return {
          name,
          model: config.model,
          status: 'completed' as const,
          result,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);

        // Only retry on empty responses (provider silently rate-limited)
        const isEmptyResponse = msg.includes('Empty response from provider');
        const canRetry = attempt < totalAttempts && isEmptyResponse;

        if (!canRetry) {
          return {
            name,
            model: config.model,
            status: msg.includes('timed out')
              ? ('timed_out' as const)
              : ('failed' as const),
            error: `Councillor "${name}": ${msg}`,
          };
        }
      }
    }

    // Unreachable, but satisfies TypeScript
    return {
      name,
      model: config.model,
      status: 'failed' as const,
      error: `Councillor "${name}": max retries exhausted`,
    };
  }
}
