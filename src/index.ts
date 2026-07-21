import type { Plugin } from '@opencode-ai/plugin';
import { createAgents, getAgentConfigs, getDisabledAgents } from './agents';
import { buildOrchestratorPrompt } from './agents/orchestrator';
import { CompanionManager } from './companion/manager';
import { ensureCompanionVersion } from './companion/updater';
import {
  type AgentOverrideConfig,
  deepMerge,
  isOrchestratorClassAgent,
  loadPluginConfig,
  type MultiplexerConfig,
} from './config';
import { parseList } from './config/agent-mcps';
import { AGENT_ALIASES } from './config/constants';
import {
  getActiveRuntimePreset,
  getPreviousRuntimePreset,
  setActiveRuntimePreset,
} from './config/runtime-preset';
import { CouncilManager } from './council';
import {
  createApplyPatchHook,
  createAutoUpdateCheckerHook,
  createChatHeadersHook,
  createCouncilDetailsHook,
  createDeepworkCommandHook,
  createDeepworkWakeupHook,
  createDelegateTaskRetryHook,
  createFilterAvailableSkillsHook,
  createFixerReviewHook,
  createJsonErrorRecoveryHook,
  createPhaseReminderHook,
  createPostFileToolNudgeHook,
  createReflectCommandHook,
  createTaskSessionManagerHook,
  ForegroundFallbackManager,
} from './hooks';
import type { MessageWithParts } from './hooks/types';
import { processFileAttachments } from './hooks/upload-hook';
import { createInterviewManager } from './interview';
import { createBuiltinMcps } from './mcp';
import {
  getMultiplexer,
  MultiplexerSessionManager,
  startAvailabilityCheck,
} from './multiplexer';
import {
  ast_grep_replace,
  ast_grep_search,
  createAcpRunTool,
  createCancelTaskTool,
  createCouncilTool,
  createPresetManager,
  createSetLoopGateTool,
  createWebfetchTool,
} from './tools';
import { recordTuiAgentModel, recordTuiAgentModels } from './tui-state';
import {
  BackgroundJobBoard,
  createDisplayNameMentionRewriter,
  resolveRuntimeAgentName,
} from './utils';
import { initLogger, log } from './utils/logger';
import { SubagentDepthTracker } from './utils/subagent-depth';
import { collapseSystemInPlace } from './utils/system-collapse';

/**
 * Best-effort log to opencode's app logger.
 * Wrapped in try/catch to avoid deadlocking on opencode v1.4.8–v1.4.9
 * where client.app.log() during init triggers a middleware cycle.
 */
async function appLog(
  ctx: Parameters<Plugin>[0],
  level: 'error' | 'warn' | 'info',
  message: string,
): Promise<void> {
  try {
    await ctx.client.app.log({
      body: { service: 'oh-my-opencode-slim', level, message },
    });
  } catch {
    // client.app.log may deadlock or be unavailable; stderr is the
    // fallback
    const prefix =
      level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO';
    console.error(`[oh-my-opencode-slim] ${prefix}: ${message}`);
  }
}

/** Minimum expected registrations for a healthy plugin load. */
const HEALTH_CHECK = {
  minAgents: 5,
  // Default tool set when council and ACP agents are not configured:
  // cancel_task, webfetch, ast_grep_search, ast_grep_replace.
  minTools: 4,
  minMcps: 1,
} as const;

/**
 * Probe jsdom at init time so the first webfetch call doesn't fail
 * silently. Logs a warning if jsdom can't be imported or instantiated,
 * but does not throw; the plugin works without webfetch.
 */
async function probeJSDOM(): Promise<string | null> {
  try {
    const { JSDOM } = await import('jsdom');
    new JSDOM('<!DOCTYPE html><html><body>test</body></html>');
    return null;
  } catch (err) {
    return String(err);
  }
}

// Module-level runtime preset tracking. Survives plugin re-inits triggered
// by client.config.update() → Instance.dispose(). When the plugin function
// re-runs, it checks this variable and applies the runtime preset instead
// of the config file's preset. State lives in config/runtime-preset.ts.

/**
 * Hardcoded model for deepwork wakeup prompts (done-check, reconcile,
 * continue, gate-fail). Pinned to glm-5p2 so the periodic wakeup turns
 * never burn gpt tokens, regardless of which orchestrator model the
 * session is using. The per-session agent is still resolved so the
 * correct orchestrator prompt is injected; only the model is pinned.
 * Change here and rebuild (`bun run build`) to use a different wakeup model.
 */
const WAKEUP_MODEL = 'fireworks-ai/accounts/fireworks/models/glm-5p2';

const OhMyOpenCodeLite: Plugin = async (ctx) => {
  const sessionId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  initLogger(sessionId);

  // Declare variables that must survive the try/catch for the return
  // closure. These are set inside the try block.
  let config: ReturnType<typeof loadPluginConfig>;
  let disabledAgents: Set<string>;
  let agentDefs: ReturnType<typeof createAgents>;
  let agents: ReturnType<typeof getAgentConfigs>;
  let mcps: ReturnType<typeof createBuiltinMcps>;
  let modelArrayMap: Record<string, Array<{ id: string; variant?: string }>>;
  let runtimeChains: Record<string, string[]>;
  let multiplexerConfig: MultiplexerConfig;
  let multiplexerEnabled: boolean;
  let depthTracker: SubagentDepthTracker;
  let multiplexerSessionManager: MultiplexerSessionManager;
  let councilManager: CouncilManager | undefined;
  // Maps child session ID → parent session ID, populated on
  // `session.created`. Used by the council-details hook to correlate a
  // `task` tool call (parent = orchestrator) with the council agent
  // session it spawned.
  let childToParent: Map<string, string>;
  let autoUpdateChecker: ReturnType<typeof createAutoUpdateCheckerHook>;
  let phaseReminderHook: ReturnType<typeof createPhaseReminderHook>;
  let filterAvailableSkillsHook: ReturnType<
    typeof createFilterAvailableSkillsHook
  >;
  let sessionAgentMap: Map<string, string>;
  let postFileToolNudgeHook: ReturnType<typeof createPostFileToolNudgeHook>;
  let chatHeadersHook: ReturnType<typeof createChatHeadersHook>;
  let delegateTaskRetryHook: ReturnType<typeof createDelegateTaskRetryHook>;
  let applyPatchHook: ReturnType<typeof createApplyPatchHook>;
  let jsonErrorRecoveryHook: ReturnType<typeof createJsonErrorRecoveryHook>;
  let foregroundFallback: ForegroundFallbackManager;
  let deepworkCommandHook: ReturnType<typeof createDeepworkCommandHook>;
  let deepworkWakeupHook: ReturnType<typeof createDeepworkWakeupHook>;
  let fixerReviewHook: ReturnType<typeof createFixerReviewHook>;
  let reflectCommandHook: ReturnType<typeof createReflectCommandHook>;
  let taskSessionManagerHook: ReturnType<typeof createTaskSessionManagerHook>;
  let councilDetailsHook: ReturnType<typeof createCouncilDetailsHook>;
  let backgroundJobBoard: BackgroundJobBoard;
  let interviewManager: ReturnType<typeof createInterviewManager>;
  let presetManager: ReturnType<typeof createPresetManager>;
  let companionManager: CompanionManager;
  let councilTools: Record<string, unknown>;
  let cancelTaskTools: Record<string, unknown>;
  let setLoopGateTools: Record<string, unknown>;
  let acpRunTools: Record<string, ReturnType<typeof createAcpRunTool>>;
  let webfetch: ReturnType<typeof createWebfetchTool>;
  let rewriteDisplayNameMentions: ReturnType<
    typeof createDisplayNameMentionRewriter
  >;

  // Counters for post-init health check (set inside try, checked outside)
  let toolCount = 0;

  try {
    config = loadPluginConfig(ctx.directory);

    // Safety net: if a runtime preset was set via /preset command and
    // OpenCode ever fully re-runs the plugin function (not just the
    // config() hook), override config.preset so agents are created with
    // the correct models. Currently only the config() hook re-runs after
    // Instance.dispose(), so this is a defensive guard.
    const runtimePreset = getActiveRuntimePreset();
    if (runtimePreset && config.presets?.[runtimePreset]) {
      config.preset = runtimePreset;
      // Re-merge runtime preset into config.agents (loadPluginConfig
      // already merged the config-file preset, not the runtime one).
      // Runtime preset is override so it wins over config-file preset.
      const presetAgents = config.presets[runtimePreset];
      config.agents = deepMerge(config.agents, presetAgents);
    } else if (runtimePreset) {
      // Preset was deleted from config since last switch — clear stale state
      setActiveRuntimePreset(null);
    }

    disabledAgents = getDisabledAgents(config);
    rewriteDisplayNameMentions = createDisplayNameMentionRewriter(config);
    agentDefs = createAgents(config);
    agents = getAgentConfigs(config);

    // Build model array map and runtime fallback chains from _modelArray
    // entries (when the user configures model as an array in
    // agents.<name>.model). A single pass populates both data structures.
    modelArrayMap = {} as Record<
      string,
      Array<{ id: string; variant?: string }>
    >;
    runtimeChains = {} as Record<string, string[]>;
    for (const agentDef of agentDefs) {
      if (agentDef._modelArray?.length) {
        modelArrayMap[agentDef.name] = agentDef._modelArray;
        runtimeChains[agentDef.name] = agentDef._modelArray.map((m) => m.id);
      }
    }

    // Parse multiplexer config with defaults
    multiplexerConfig = {
      type: config.multiplexer?.type ?? 'none',
      layout: config.multiplexer?.layout ?? 'main-vertical',
      main_pane_size: config.multiplexer?.main_pane_size ?? 60,
      zellij_pane_mode: config.multiplexer?.zellij_pane_mode ?? 'agent-tab',
    };

    // Get multiplexer instance for capability checks
    const multiplexer = getMultiplexer(multiplexerConfig);
    multiplexerEnabled =
      multiplexerConfig.type !== 'none' &&
      multiplexer !== null &&
      multiplexer.isInsideSession();

    log('[plugin] initialized with multiplexer config', {
      multiplexerConfig,
      enabled: multiplexerEnabled,
      directory: ctx.directory,
    });

    // Start background availability check if enabled
    if (multiplexerEnabled) {
      startAvailabilityCheck(multiplexerConfig);
    }

    depthTracker = new SubagentDepthTracker();
    childToParent = new Map<string, string>();

    // Initialize council tools (only when council is configured)
    if (config.council) {
      councilManager = new CouncilManager(
        ctx,
        config,
        depthTracker,
        multiplexerEnabled,
      );
      councilTools = createCouncilTool(ctx, councilManager);
      councilDetailsHook = createCouncilDetailsHook(
        councilManager,
        childToParent,
      );
    } else {
      councilTools = {};
    }

    mcps = createBuiltinMcps(config.disabled_mcps, config.websearch);
    acpRunTools =
      Object.keys(config.acpAgents ?? {}).length > 0
        ? { acp_run: createAcpRunTool(config.acpAgents) }
        : {};
    webfetch = createWebfetchTool(ctx);
    backgroundJobBoard = new BackgroundJobBoard({
      maxReusablePerAgent: config.backgroundJobs?.maxSessionsPerAgent ?? 2,
      readContextMinLines: config.backgroundJobs?.readContextMinLines ?? 10,
      readContextMaxFiles: config.backgroundJobs?.readContextMaxFiles ?? 8,
    });

    // Initialize MultiplexerSessionManager to handle OpenCode's built-in
    // Task tool sessions
    multiplexerSessionManager = new MultiplexerSessionManager(
      ctx,
      multiplexerConfig,
      backgroundJobBoard,
    );

    // Initialize auto-update checker hook
    autoUpdateChecker = createAutoUpdateCheckerHook(ctx, {
      autoUpdate: config.autoUpdate ?? true,
      companion: config.companion,
    });

    // Initialize phase reminder hook for workflow compliance
    phaseReminderHook = createPhaseReminderHook();

    // Initialize available skills filter hook
    filterAvailableSkillsHook = createFilterAvailableSkillsHook(ctx, config);

    // Track session → agent mapping for serve-mode system prompt injection
    sessionAgentMap = new Map<string, string>();

    // Initialize post-file-tool nudge hook
    postFileToolNudgeHook = createPostFileToolNudgeHook({
      shouldInject: (sessionID) =>
        isOrchestratorClassAgent(config, sessionAgentMap.get(sessionID)),
    });

    chatHeadersHook = createChatHeadersHook(ctx);

    // Initialize delegate-task retry guidance hook
    delegateTaskRetryHook = createDelegateTaskRetryHook(ctx);

    applyPatchHook = createApplyPatchHook(ctx);
    // Initialize JSON parse error recovery hook
    jsonErrorRecoveryHook = createJsonErrorRecoveryHook(ctx);

    // Initialize foreground fallback manager for runtime model switching
    foregroundFallback = new ForegroundFallbackManager(
      ctx.client,
      runtimeChains,
      config.fallback?.enabled !== false &&
        Object.keys(runtimeChains).length > 0,
    );

    deepworkCommandHook = createDeepworkCommandHook();
    reflectCommandHook = createReflectCommandHook();
    taskSessionManagerHook = createTaskSessionManagerHook(ctx, {
      maxSessionsPerAgent: config.backgroundJobs?.maxSessionsPerAgent ?? 2,
      readContextMinLines: config.backgroundJobs?.readContextMinLines ?? 10,
      readContextMaxFiles: config.backgroundJobs?.readContextMaxFiles ?? 8,
      backgroundJobBoard,
      shouldManageSession: (sessionID) =>
        isOrchestratorClassAgent(config, sessionAgentMap.get(sessionID)),
    });
    deepworkWakeupHook = createDeepworkWakeupHook(ctx.client, {
      backgroundJobBoard,
      shouldManageSession: (sessionID) =>
        isOrchestratorClassAgent(config, sessionAgentMap.get(sessionID)),
      directory: ctx.directory,
      // Disable the periodic done-check. After a manual abort, OpenCode emits
      // only session.idle (no abort event), so the hook cannot tell "stopped
      // by user" from "finished a turn" and the 5s poll re-executes the thread
      // the user just stopped. Event-driven wakes (background completion →
      // reconcile) and one-shot gate firing still work.
      periodicDoneCheck: false,
      resolveModel: async (sessionID) => {
        // Resolve the session's agent so promptAsync routes to the correct
        // orchestrator (and the right system prompt is injected). The MODEL
        // is hardcoded to WAKEUP_MODEL (glm-5p2) — see the constant above the
        // plugin function — so wakeup turns never burn gpt tokens.
        let agentName = sessionAgentMap.get(sessionID);

        // After a restart, sessionAgentMap is empty. Query the session's
        // messages to find the agent from the FIRST message with an agent
        // field — that's the session's original agent (the user's selection).
        // Using the last message would be wrong: the wakeup hook's own
        // promptAsync calls (which may have used the wrong model) create
        // messages with the default agent, polluting the agent field.
        if (!agentName) {
          try {
            const result = await ctx.client.session.messages({
              path: { id: sessionID },
            });
            const messages = (result.data ?? []) as Array<{
              info?: { agent?: string };
            }>;
            const firstWithAgent = messages.find(
              (m) => typeof m.info?.agent === 'string',
            );
            agentName = firstWithAgent?.info?.agent;
            if (agentName) {
              sessionAgentMap.set(sessionID, agentName);
              log('[plugin] resolved agent from first message for wakeup', {
                sessionID,
                agentName,
              });
            }
          } catch {
            // Session may not exist yet — leave agentName undefined
          }
        }

        // Model is pinned to WAKEUP_MODEL (glm-5p2) regardless of the
        // session's configured orchestrator model, so wakeup prompts
        // (done-check / reconcile / continue / gate-fail) never burn gpt
        // tokens. The agent is still passed so the correct orchestrator
        // prompt and context are used.
        const slash = WAKEUP_MODEL.indexOf('/');
        if (slash <= 0 || slash >= WAKEUP_MODEL.length - 1) return undefined;
        return {
          providerID: WAKEUP_MODEL.slice(0, slash),
          modelID: WAKEUP_MODEL.slice(slash + 1),
          agent: agentName,
        };
      },
      // Resolve the oracle specialist name for a given orchestrator agent
      // name. Custom orchestrators with a `specialists` override get a
      // scoped oracle subagent registered as `oracle__<orchestratorName>`
      // (with the overridden model, e.g. gpt-5.6-sol); other orchestrators
      // use the generic `oracle`. The adjudicator gate-check prompt uses
      // this so the oracle runs on the right model, not the default.
      resolveOracleSpecialistName: (orchestratorAgentName: string) => {
        const scopedName = `oracle__${orchestratorAgentName}`;
        if (agentDefs.some((a) => a.name === scopedName)) return scopedName;
        return 'oracle';
      },
    });
    // Resolve oracle model for fixer-review auto-review hook
    const oracleAgentDef = agentDefs.find((a) => a.name === 'oracle');
    const oracleModel =
      (typeof oracleAgentDef?.config.model === 'string'
        ? oracleAgentDef.config.model
        : undefined) ?? oracleAgentDef?._modelArray?.[0]?.id;
    fixerReviewHook = createFixerReviewHook(ctx.client, {
      oracleModel,
      directory: ctx.directory,
    });
    interviewManager = createInterviewManager(ctx, config);
    presetManager = createPresetManager(ctx, config);
    companionManager = new CompanionManager(
      `proc_${process.pid}`,
      ctx.directory,
      config.companion,
    );
    cancelTaskTools = createCancelTaskTool({
      client: ctx.client,
      backgroundJobBoard,
      shouldManageSession: (sessionID) =>
        isOrchestratorClassAgent(config, sessionAgentMap.get(sessionID)),
    });
    setLoopGateTools = createSetLoopGateTool({
      setGate: (sessionID, gate) => deepworkWakeupHook.setGate(sessionID, gate),
      shouldManageSession: (sessionID) =>
        isOrchestratorClassAgent(config, sessionAgentMap.get(sessionID)),
      // Post-restart fallback: sessionAgentMap may be empty because the
      // chat.message hook hasn't populated it yet (it fires on the
      // orchestrator's RESPONSE, but the orchestrator tries set_loop_gate
      // DURING its response). Query the session's messages to find the
      // agent from the FIRST message with an agent field — that's the
      // session's original agent (the user's selection).
      shouldManageSessionAsync: async (sessionID) => {
        try {
          const result = await ctx.client.session.messages({
            path: { id: sessionID },
          });
          const messages = (result.data ?? []) as Array<{
            info?: { agent?: string };
          }>;
          const firstWithAgent = messages.find(
            (m) => typeof m.info?.agent === 'string',
          );
          const agentName = firstWithAgent?.info?.agent;
          if (agentName) {
            sessionAgentMap.set(sessionID, agentName);
            log('[plugin] resolved agent from messages for set_loop_gate', {
              sessionID,
              agentName,
            });
            return isOrchestratorClassAgent(config, agentName);
          }
        } catch (err) {
          log('[plugin] shouldManageSessionAsync failed', {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return false;
      },
    });

    toolCount =
      Object.keys(councilTools).length +
      Object.keys(cancelTaskTools).length +
      Object.keys(setLoopGateTools).length +
      Object.keys(acpRunTools).length +
      1 + // webfetch
      2; // ast_grep_search, ast_grep_replace
  } catch (err) {
    // Plugin init failed: log visibly before re-throwing so the user
    // sees something actionable instead of a silent "loaded but empty".
    log('[plugin] FATAL: init failed', String(err));
    await appLog(
      ctx,
      'error',
      `INIT FAILED: ${String(err)}. Report at github.com/alvinunreal/oh-my-opencode-slim/issues/310`,
    );
    throw err;
  }

  // ── Health check: validate registrations ────────────────────────────
  const agentCount = Object.keys(agents).length;
  const mcpCount = Object.keys(mcps).length;
  // Skip MCP threshold when user explicitly disabled all built-in MCPs
  const mcpThreshold =
    config.disabled_mcps && config.disabled_mcps.length > 0
      ? 0
      : HEALTH_CHECK.minMcps;

  if (
    agentCount < HEALTH_CHECK.minAgents ||
    toolCount < HEALTH_CHECK.minTools ||
    mcpCount < mcpThreshold
  ) {
    const msg = [
      'Health check: registrations suspiciously low.',
      `  agents: ${agentCount} (expected >=${HEALTH_CHECK.minAgents})`,
      `  tools:  ${toolCount} (expected >=${HEALTH_CHECK.minTools})`,
      `  mcps:   ${mcpCount} (expected >=${mcpThreshold})`,
      'This usually means a dependency failed to resolve (jsdom, etc).',
      'If you recently updated opencode, see:',
      '  github.com/alvinunreal/oh-my-opencode-slim/issues/310',
    ].join('\n');
    log(`[plugin] WARN: ${msg}`);
    await appLog(ctx, 'warn', msg);
  } else {
    log('[plugin] health check passed', {
      agents: agentCount,
      tools: toolCount,
      mcps: mcpCount,
    });
  }

  // ── Probe jsdom (async, non-blocking) ───────────────────────────────
  // Don't await this; we don't want to block init. The warning will
  // appear shortly after startup if jsdom is broken.
  probeJSDOM().then((err) => {
    if (err) {
      const msg = `jsdom probe failed; webfetch tool will not work: ${err}`;
      log(`[plugin] WARN: ${msg}`);
      appLog(ctx, 'warn', msg).catch(() => {});
    }
  });

  if (config.companion?.enabled === true) {
    try {
      const companionResult = await ensureCompanionVersion({
        config: config.companion,
        downloadTimeoutMs: 3_000,
        lockTimeoutMs: 500,
      });
      if (companionResult.status === 'installed') {
        log('[companion] updated before startup', companionResult.version);
      } else if (companionResult.status === 'failed') {
        log('[companion] startup update failed', companionResult.error);
      }
    } catch (err) {
      log('[companion] startup update failed', String(err));
    }
  }

  companionManager.onLoad();

  return {
    name: 'oh-my-opencode-slim',

    agent: agents,

    tool: {
      ...councilTools,
      ...cancelTaskTools,
      ...setLoopGateTools,
      ...acpRunTools,
      webfetch,
      ast_grep_search,
      ast_grep_replace,
    },

    mcp: mcps,

    config: async (opencodeConfig: Record<string, unknown>) => {
      // Only set default_agent if not already configured by the user
      // and the plugin config doesn't explicitly disable this behavior
      if (
        config.setDefaultAgent !== false &&
        !(opencodeConfig as { default_agent?: string }).default_agent
      ) {
        (opencodeConfig as { default_agent?: string }).default_agent =
          'orchestrator';
      }

      // Merge Agent configs — per-agent shallow merge to preserve
      // user-supplied fields (e.g. tools, permission) from opencode.json
      if (!opencodeConfig.agent) {
        opencodeConfig.agent = { ...agents };
      } else {
        for (const [name, pluginAgent] of Object.entries(agents)) {
          const existing = (opencodeConfig.agent as Record<string, unknown>)[
            name
          ] as Record<string, unknown> | undefined;
          if (existing) {
            // Shallow merge: plugin defaults first, user overrides win
            (opencodeConfig.agent as Record<string, unknown>)[name] = {
              ...pluginAgent,
              ...existing,
            };
          } else {
            (opencodeConfig.agent as Record<string, unknown>)[name] = {
              ...pluginAgent,
            };
          }
        }
      }
      const configAgent = opencodeConfig.agent as Record<string, unknown>;

      // Model resolution for foreground agents: use _modelArray entries
      // to pick the first model for startup-time selection.
      //
      // Runtime failover on API errors (e.g. rate limits
      // mid-conversation) is handled separately by
      // ForegroundFallbackManager via the event hook.
      if (Object.keys(modelArrayMap).length > 0) {
        for (const [agentName, models] of Object.entries(modelArrayMap)) {
          if (models.length === 0) continue;

          // Use the first model in the model array. Not all providers
          // require entries in opencodeConfig.provider — some are loaded
          // automatically by opencode (e.g. github-copilot, openrouter).
          // We cannot distinguish these from truly unconfigured providers
          // at config-hook time, so we cannot gate on the provider config
          // keys. Runtime failover is handled separately by
          // ForegroundFallbackManager.
          const chosen = models[0];
          const entry = configAgent[agentName] as
            | Record<string, unknown>
            | undefined;
          if (entry) {
            entry.model = chosen.id;
            if (chosen.variant) {
              entry.variant = chosen.variant;
            }
          } else {
            // Agent exists in slim but not in opencodeConfig.agent —
            // create entry
            (configAgent as Record<string, unknown>)[agentName] = {
              model: chosen.id,
              ...(chosen.variant ? { variant: chosen.variant } : {}),
            };
          }
          log('[plugin] resolved model from array', {
            agent: agentName,
            model: chosen.id,
            variant: chosen.variant,
          });
        }
      }

      // Runtime preset override: if /preset switched to a runtime preset,
      // override the model/variant/temperature from the preset's agent
      // config. This runs after the normal model resolution because the
      // config() hook re-runs with stale modelArrayMap after dispose(),
      // but the runtime preset data is in the captured `config` closure.
      const runtimePresetName = getActiveRuntimePreset();
      if (runtimePresetName && config.presets?.[runtimePresetName]) {
        const runtimePreset = config.presets[runtimePresetName];
        for (const [agentName, override] of Object.entries(runtimePreset)) {
          // Resolve legacy alias keys (e.g. "explore" → "explorer")
          // so presets using aliases work in this path.
          const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
          const entry = configAgent[resolvedName] as
            | Record<string, unknown>
            | undefined;
          if (!entry) continue;

          if (typeof override.model === 'string') {
            entry.model = override.model;
          } else if (
            Array.isArray(override.model) &&
            override.model.length > 0
          ) {
            const first = override.model[0];
            entry.model = typeof first === 'string' ? first : first.id;
            // Extract inline variant from array-form model entry
            if (typeof first !== 'string' && first.variant) {
              entry.variant = first.variant;
            }
          }
          // Explicitly set or clear scalar fields so switching from
          // Preset A (which sets a field) to Preset B (which doesn't)
          // doesn't leave stale values behind.
          if (typeof override.variant === 'string') {
            entry.variant = override.variant;
          } else if ('variant' in override) {
            delete entry.variant;
          }
          if (typeof override.temperature === 'number') {
            entry.temperature = override.temperature;
          } else if ('temperature' in override) {
            delete entry.temperature;
          }
          if (
            override.options &&
            typeof override.options === 'object' &&
            !Array.isArray(override.options)
          ) {
            entry.options = override.options;
          } else if ('options' in override) {
            delete entry.options;
          }
          log('[plugin] runtime preset override', {
            preset: runtimePresetName,
            agent: agentName,
            model: entry.model as string,
          });
        }

        // Reset agents from the previous preset that aren't in the new one.
        // The stale model resolution above overwrites the reset values sent
        // by preset-manager, so we re-apply them here from config-file
        // baseline.
        const prevPresetName = getPreviousRuntimePreset();
        if (prevPresetName && config.presets?.[prevPresetName]) {
          const prevPreset = config.presets[prevPresetName];
          // Build resolved key set from new preset for correct comparison
          // (handles alias keys like "explore" → "explorer")
          const newPresetResolved = new Set(
            Object.keys(runtimePreset).map((k) => AGENT_ALIASES[k] ?? k),
          );
          for (const agentName of Object.keys(prevPreset)) {
            const resolvedName = AGENT_ALIASES[agentName] ?? agentName;
            if (newPresetResolved.has(resolvedName)) continue; // new preset handles it
            const entry = configAgent[resolvedName] as
              | Record<string, unknown>
              | undefined;
            if (!entry) continue;
            // Reset to config-file baseline. Use the previous preset's
            // override to identify which fields to clear even when the
            // baseline doesn't define them.
            const baseline = config.agents?.[resolvedName];
            const prevOverride = prevPreset[agentName] as
              | AgentOverrideConfig
              | undefined;
            if (typeof baseline?.model === 'string') {
              entry.model = baseline.model;
            }
            if (typeof baseline?.variant === 'string') {
              entry.variant = baseline.variant;
            } else if (prevOverride && 'variant' in prevOverride) {
              delete entry.variant;
            }
            if (typeof baseline?.temperature === 'number') {
              entry.temperature = baseline.temperature;
            } else if (prevOverride && 'temperature' in prevOverride) {
              delete entry.temperature;
            }
            if (
              baseline?.options &&
              typeof baseline.options === 'object' &&
              !Array.isArray(baseline.options)
            ) {
              entry.options = baseline.options;
            } else if (prevOverride && 'options' in prevOverride) {
              delete entry.options;
            }
            log('[plugin] runtime preset reset from previous', {
              previousPreset: prevPresetName,
              agent: resolvedName,
              model: entry.model as string,
            });
          }
        }
      }

      const tuiAgentModels: Record<string, string> = {};
      for (const agentDef of agentDefs) {
        if (agentDef.name === 'councillor') continue;

        const entry = configAgent[agentDef.name] as
          | Record<string, unknown>
          | undefined;
        const resolvedModel =
          typeof entry?.model === 'string'
            ? entry.model
            : runtimeChains[agentDef.name]?.[0]
              ? runtimeChains[agentDef.name][0]
              : typeof agentDef.config.model === 'string'
                ? agentDef.config.model
                : undefined;

        tuiAgentModels[agentDef.name] = resolvedModel ?? 'default';
      }
      recordTuiAgentModels({ agentModels: tuiAgentModels });

      // Merge MCP configs
      const configMcp = opencodeConfig.mcp as
        | Record<string, unknown>
        | undefined;
      if (!configMcp) {
        opencodeConfig.mcp = { ...mcps };
      } else {
        Object.assign(configMcp, mcps);
      }

      // Get all MCP names from the merged config (built-in + custom)
      const mergedMcpConfig = opencodeConfig.mcp as
        | Record<string, unknown>
        | undefined;
      const allMcpNames = Object.keys(mergedMcpConfig ?? mcps);

      // For each agent, create permission rules based on their mcps list
      for (const [agentName, agentConfig] of Object.entries(agents)) {
        const agentMcps = (agentConfig as { mcps?: string[] })?.mcps;
        if (!agentMcps) continue;

        // Get or create agent permission config
        if (!configAgent[agentName]) {
          configAgent[agentName] = { ...agentConfig };
        }
        const agentConfigEntry = configAgent[agentName] as Record<
          string,
          unknown
        >;
        const agentPermission = (agentConfigEntry.permission ?? {}) as Record<
          string,
          unknown
        >;

        // Parse mcps list with wildcard and exclusion support
        const allowedMcps = parseList(agentMcps, allMcpNames);

        // Create permission rules for each MCP
        // MCP tools are named as <server>_<tool>, so we use <server>_*
        for (const mcpName of allMcpNames) {
          const sanitizedMcpName = mcpName.replace(/[^a-zA-Z0-9_-]/g, '_');
          const permissionKey = `${sanitizedMcpName}_*`;
          const action = allowedMcps.includes(mcpName) ? 'allow' : 'deny';

          // Only set if not already defined by user
          if (!(permissionKey in agentPermission)) {
            agentPermission[permissionKey] = action;
          }
        }

        // Update agent config with permissions
        agentConfigEntry.permission = agentPermission;
      }

      interviewManager.registerCommand(opencodeConfig);
      deepworkCommandHook.registerCommand(opencodeConfig);
      reflectCommandHook.registerCommand(opencodeConfig);
      presetManager.registerCommand(opencodeConfig);
    },

    event: async (input) => {
      const event = input.event as {
        type: string;
        properties?: {
          info?: {
            id?: string;
            parentID?: string;
            title?: string;
            agent?: string;
            providerID?: string;
            modelID?: string;
            sessionID?: string;
          };
          sessionID?: string;
          id?: string;
          requestID?: string;
          status?: { type: string };
        };
      };

      if (event.type === 'message.updated') {
        const info = event.properties?.info;
        if (
          typeof info?.agent === 'string' &&
          typeof info.providerID === 'string' &&
          typeof info.modelID === 'string'
        ) {
          recordTuiAgentModel({
            agentName: resolveRuntimeAgentName(config, info.agent),
            model: `${info.providerID}/${info.modelID}`,
          });
        }
      }

      if (event.type === 'session.created') {
        const childSessionId = event.properties?.info?.id;
        const parentSessionId = event.properties?.info?.parentID;
        if (depthTracker && childSessionId && parentSessionId) {
          depthTracker.registerChild(parentSessionId, childSessionId);
        }
        // Track child → parent for council-details hook correlation.
        if (childSessionId && parentSessionId) {
          childToParent.set(childSessionId, parentSessionId);
        }
      }

      // Handle multiplexer pane spawning for OpenCode's Task tool sessions
      await multiplexerSessionManager.onSessionCreated(event);

      // Handle session status/idle events for pane cleanup early so child panes
      // close promptly even if later hooks do additional work on idle.
      await multiplexerSessionManager.onSessionStatus(event);

      // Handle session.deleted events for pane cleanup
      await multiplexerSessionManager.onSessionDeleted(event);

      // Runtime model fallback for foreground agents (rate-limit detection)
      await foregroundFallback.handleEvent(input.event);

      // Handle auto-update checking
      await autoUpdateChecker.event(input);

      await interviewManager.handleEvent(
        input as {
          event: { type: string; properties?: Record<string, unknown> };
        },
      );

      await taskSessionManagerHook.event(
        input as {
          event: {
            type: string;
            properties?: { info?: { id?: string }; sessionID?: string };
          };
        },
      );

      await deepworkWakeupHook.event(
        input as {
          event: {
            type: string;
            properties?: {
              info?: { id?: string };
              sessionID?: string;
              status?: { type?: string };
            };
          };
        },
      );

      if (
        event.type === 'permission.asked' ||
        event.type === 'question.asked'
      ) {
        companionManager.onWaitingInput();
      }

      if (
        event.type === 'permission.replied' ||
        event.type === 'question.replied' ||
        event.type === 'question.rejected'
      ) {
        companionManager.onInputResolved();
      }

      if (input.event.type === 'session.status') {
        const props = input.event.properties as
          | { sessionID?: string; status?: { type?: string } }
          | undefined;
        const sessionID = props?.sessionID;
        companionManager.onSessionStatus({
          sessionId: sessionID,
          agent: sessionID ? sessionAgentMap.get(sessionID) : undefined,
          status: props?.status?.type,
        });
      }

      if (input.event.type === 'session.deleted') {
        const props = input.event.properties as
          | { info?: { id?: string }; sessionID?: string }
          | undefined;
        const sessionID = props?.info?.id ?? props?.sessionID;
        companionManager.onSessionDeleted(sessionID);
      }

      if (input.event.type === 'session.deleted') {
        const props = input.event.properties as
          | { info?: { id?: string }; sessionID?: string }
          | undefined;
        const sessionID = props?.info?.id ?? props?.sessionID;

        if (depthTracker && sessionID) {
          depthTracker.cleanup(sessionID);
        }
        if (sessionID) {
          sessionAgentMap.delete(sessionID);
          childToParent.delete(sessionID);
          // Clear any stashed council results for this session to avoid
          // stale entries lingering after the session is gone.
          councilManager?.clearStash(sessionID);
        }
      }
    },

    // Best-effort rescue only for stale apply_patch input before native
    // execution
    'tool.execute.before': async (input, output) => {
      await applyPatchHook['tool.execute.before'](
        input as {
          tool: string;
          directory?: string;
        },
        output as {
          args?: { patchText?: unknown; [key: string]: unknown };
        },
      );

      await taskSessionManagerHook['tool.execute.before'](
        input as {
          tool: string;
          sessionID?: string;
          callID?: string;
        },
        output as { args?: unknown },
      );

      // Track council task calls so tool.execute.after can re-append
      // verbatim councillor details if the council agent trimmed them.
      if (councilDetailsHook) {
        await councilDetailsHook['tool.execute.before'](
          input as { tool: string; sessionID?: string; callID?: string },
          output as { args?: unknown },
        );
      }

      // Capture fixer task calls for auto-oracle-review on non-trivial diffs
      await fixerReviewHook['tool.execute.before'](
        input as { tool: string; callID?: string; sessionID?: string },
        output as { args?: unknown },
      );
    },

    'command.execute.before': async (input, output) => {
      await interviewManager.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );

      await presetManager.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );

      await deepworkCommandHook.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );

      await reflectCommandHook.handleCommandExecuteBefore(
        input as {
          command: string;
          sessionID: string;
          arguments: string;
        },
        output as { parts: Array<{ type: string; text?: string }> },
      );
    },

    'chat.headers': chatHeadersHook['chat.headers'],

    // Track which agent each session uses (needed for serve-mode prompt
    // injection)
    'chat.message': async (
      input: { sessionID: string; agent?: string },
      output?: { message?: { agent?: string } },
    ) => {
      const rawAgent = input.agent ?? output?.message?.agent;
      const agent = rawAgent
        ? resolveRuntimeAgentName(config, rawAgent)
        : undefined;

      if (
        agent &&
        output?.message &&
        typeof output.message.agent === 'string'
      ) {
        output.message.agent = agent;
      }

      if (agent) {
        sessionAgentMap.set(input.sessionID, agent);
        // A chat message means this session is actively working. This also
        // covers the race where session.status busy fires before the
        // session's agent is known.
        companionManager.onSessionStatus({
          sessionId: input.sessionID,
          agent,
          status: 'busy',
        });
      }
    },

    // Inject orchestrator system prompt for serve-mode sessions. In serve
    // mode, the agent's prompt field may be absent from the agents
    // registry (built before plugin config hooks run). This hook injects
    // it at LLM call time. Uses the already-resolved prompt from
    // agentDefs (which has custom replacement or append prompts applied)
    // instead of rebuilding the default.
    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      const agentName = input.sessionID
        ? sessionAgentMap.get(input.sessionID)
        : undefined;
      if (isOrchestratorClassAgent(config, agentName)) {
        const alreadyInjected = output.system.some(
          (s) =>
            typeof s === 'string' &&
            s.includes('<Role>') &&
            s.includes('orchestrator'),
        );
        if (!alreadyInjected) {
          // Prepend the orchestrator prompt to the system array. Use the
          // resolved prompt from the orchestrator agent definition (which
          // includes any custom replacement or append from orchestrator.md
          // / orchestrator_append.md) Fall back to
          // buildOrchestratorPrompt only if the resolved prompt is
          // missing.
          const orchestratorDef = agentDefs.find((a) => a.name === agentName);
          const orchestratorPrompt =
            typeof orchestratorDef?.config?.prompt === 'string'
              ? orchestratorDef.config.prompt
              : buildOrchestratorPrompt(disabledAgents);
          output.system[0] =
            orchestratorPrompt +
            (output.system[0] ? `\n\n${output.system[0]}` : '');
        }
      }

      // Collapse to single system message for provider compatibility.
      // Some providers (e.g. Qwen via VLLM/DashScope) reject multiple
      // system messages. Sub-hooks above may push additional entries; join
      // them back into one element so OpenCode emits a single system
      // message.
      collapseSystemInPlace(output.system);
    },

    // Inject phase reminder and filter available skills before sending to
    // API (doesn't show in UI)
    'experimental.chat.messages.transform': async (
      input: Record<string, never>,
      output: { messages: unknown[] },
    ): Promise<void> => {
      const typedOutput = output as { messages: MessageWithParts[] };

      for (const message of typedOutput.messages) {
        if (message.info.role !== 'user') {
          continue;
        }
        for (const part of message.parts) {
          if (part.type !== 'text' || typeof part.text !== 'string') {
            continue;
          }
          part.text = rewriteDisplayNameMentions(part.text);
        }
      }

      // Persist ALL uploaded file types (images, PDFs, docs, etc.) to
      // .opencode/uploads/ and inject their disk path as text. The path
      // survives the text-only `task` delegation hop so subagents can
      // read the file with their read tool. Image bytes are stripped
      // (orchestrator models that don't support image input would fail
      // the API call); non-image file parts are kept alongside the
      // injected path so models that support them retain native access.
      processFileAttachments({
        messages: typedOutput.messages,
        workDir: ctx.directory,
        log,
      });

      await taskSessionManagerHook['experimental.chat.messages.transform'](
        input,
        typedOutput,
      );
      await phaseReminderHook['experimental.chat.messages.transform'](
        input,
        typedOutput,
      );
      await filterAvailableSkillsHook['experimental.chat.messages.transform'](
        input,
        typedOutput,
      );
    },

    // Post-tool hooks: retry guidance for delegation errors + file-tool
    // nudge
    'tool.execute.after': async (input, output) => {
      const meta = input as {
        tool?: string;
        sessionID?: string;
        callID?: string;
      };
      const runPostToolHook = async (
        name: string,
        fn: () => Promise<void>,
      ): Promise<void> => {
        try {
          await fn();
        } catch (error) {
          log('[plugin] post-tool hook failed open', {
            hook: name,
            tool: meta.tool,
            sessionID: meta.sessionID,
            callID: meta.callID,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      await runPostToolHook('delegate-task-retry', () =>
        delegateTaskRetryHook['tool.execute.after'](
          input as { tool: string },
          output as { output: unknown },
        ),
      );

      await runPostToolHook('json-error-recovery', () =>
        jsonErrorRecoveryHook['tool.execute.after'](
          input as {
            tool: string;
            sessionID: string;
            callID: string;
          },
          output as {
            title: string;
            output: unknown;
            metadata: unknown;
          },
        ),
      );

      await runPostToolHook('post-file-tool-nudge', () =>
        postFileToolNudgeHook['tool.execute.after'](
          input as {
            tool: string;
            sessionID?: string;
            callID?: string;
          },
          output as {
            title: string;
            output: string;
            metadata: Record<string, unknown>;
          },
        ),
      );

      await runPostToolHook('task-session-manager', () =>
        taskSessionManagerHook['tool.execute.after'](
          input as {
            tool: string;
            sessionID?: string;
            callID?: string;
          },
          output as { output: unknown },
        ),
      );

      // Deterministically ensure verbatim per-councillor details appear
      // in council task output, even if the council agent trimmed them.
      if (councilDetailsHook) {
        await runPostToolHook('council-details', () =>
          councilDetailsHook['tool.execute.after'](
            input as {
              tool: string;
              sessionID?: string;
              callID?: string;
            },
            output as { output?: unknown },
          ),
        );
      }

      // Auto-spawn oracle review on non-trivial fixer diffs
      await runPostToolHook('fixer-review', () =>
        fixerReviewHook['tool.execute.after'](
          input as {
            tool: string;
            callID?: string;
            sessionID?: string;
          },
          output as { output: unknown },
        ),
      );
    },
  };
};

export default OhMyOpenCodeLite;

export type {
  AgentName,
  AgentOverrideConfig,
  McpName,
  MultiplexerConfig,
  MultiplexerLayout,
  MultiplexerType,
  PluginConfig,
  TmuxConfig,
  TmuxLayout,
} from './config';
export type { RemoteMcpConfig } from './mcp';
