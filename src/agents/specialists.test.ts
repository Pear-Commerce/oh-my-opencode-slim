import { describe, expect, test } from 'bun:test';
import { DEFAULT_MODELS, type PluginConfig } from '../config';
import { createAgents, getAgentConfigs } from './index';

// Canonical config shape from the feature spec: a custom orchestrator-class
// agent that scopes its oracle specialist to a different model/variant.
function solConfig(): PluginConfig {
  return {
    agents: {
      'orchestrator-glm52-sol': {
        orchestrator_class: true,
        model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
        specialists: {
          oracle: {
            model: 'openrouter/openai/gpt-5.6-sol',
            variant: 'high',
            skills: ['simplify'],
            mcps: [],
          },
        },
      },
    },
  };
}

describe('scoped specialist build behavior', () => {
  test('scoped oracle is built with overridden model and variant', () => {
    const agents = createAgents(solConfig());
    const scoped = agents.find(
      (a) => a.name === 'oracle__orchestrator-glm52-sol',
    );

    expect(scoped).toBeDefined();
    expect(scoped?.config.model).toBe('openrouter/openai/gpt-5.6-sol');
    expect(scoped?.config.variant).toBe('high');
    expect(scoped?.hidden).toBe(true);
  });

  test('scoped oracle is registered in getAgentConfigs as hidden subagent', () => {
    const configs = getAgentConfigs(solConfig()) as Record<
      string,
      { mode?: string; hidden?: boolean; mcps?: string[] }
    >;

    expect(configs['oracle__orchestrator-glm52-sol']).toBeDefined();
    expect(configs['oracle__orchestrator-glm52-sol'].mode).toBe('subagent');
    expect(configs['oracle__orchestrator-glm52-sol'].hidden).toBe(true);
  });

  test('owner orchestrator prompt routes @oracle to the scoped name', () => {
    const agents = createAgents(solConfig());
    const owner = agents.find((a) => a.name === 'orchestrator-glm52-sol');
    const prompt = owner?.config.prompt ?? '';

    // Scoped name present in both the AGENT_DESCRIPTIONS block and the
    // VALIDATION_ROUTING block (which mentions @oracle for code review).
    expect(prompt).toContain('@oracle__orchestrator-glm52-sol');
    // No bare @oracle token remains anywhere in the owner prompt.
    expect(prompt).not.toMatch(/@oracle\b/);
  });

  test('default orchestrator is isolated and keeps @oracle', () => {
    const agents = createAgents(solConfig());
    const def = agents.find((a) => a.name === 'orchestrator');
    const prompt = def?.config.prompt ?? '';

    expect(prompt).toMatch(/@oracle\b/);
    expect(prompt).not.toContain('@oracle__orchestrator-glm52-sol');
  });

  test('other custom orchestrator without specialists keeps @oracle', () => {
    const config: PluginConfig = {
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: {
              model: 'openrouter/openai/gpt-5.6-sol',
              variant: 'high',
            },
          },
        },
        'orchestrator-kimi': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/kimi-k2p7-code',
        },
      },
    };

    const agents = createAgents(config);
    const kimi = agents.find((a) => a.name === 'orchestrator-kimi');
    const prompt = kimi?.config.prompt ?? '';

    expect(prompt).toMatch(/@oracle\b/);
    expect(prompt).not.toContain('@oracle__orchestrator-glm52-sol');
  });

  test('base oracle agent remains unchanged with default model', () => {
    const agents = createAgents(solConfig());
    const baseOracle = agents.find((a) => a.name === 'oracle');

    expect(baseOracle).toBeDefined();
    expect(baseOracle?.config.model).toBe(DEFAULT_MODELS.oracle);
    expect(baseOracle?.config.variant).toBeUndefined();
    expect(baseOracle?.hidden).toBeUndefined();
  });

  test('scoped oracle skill permission reflects configured skills list', () => {
    const agents = createAgents(solConfig());
    const scoped = agents.find(
      (a) => a.name === 'oracle__orchestrator-glm52-sol',
    );
    const skillPerm = (scoped?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;

    expect(skillPerm).toEqual({ '*': 'deny', simplify: 'allow' });
  });

  test('scoped oracle with explicit empty mcps yields []', () => {
    const configs = getAgentConfigs(solConfig());
    expect(configs['oracle__orchestrator-glm52-sol'].mcps).toEqual([]);
  });

  test('scoped librarian with no mcps inherits base librarian defaults', () => {
    const config: PluginConfig = {
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            librarian: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    };

    const configs = getAgentConfigs(config);
    expect(configs['librarian__orchestrator-glm52-sol'].mcps).toEqual([
      'websearch',
      'context7',
      'gh_grep',
    ]);
  });

  test('scoped specialist inherits base skill defaults when skills omitted', () => {
    // oracle gets `requesting-code-review` and `simplify` skills by default.
    const config: PluginConfig = {
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    };

    const agents = createAgents(config);
    const scoped = agents.find(
      (a) => a.name === 'oracle__orchestrator-glm52-sol',
    );
    const skillPerm = (scoped?.config.permission as Record<string, unknown>)
      ?.skill as Record<string, string>;

    expect(skillPerm?.['requesting-code-review']).toBe('allow');
    expect(skillPerm?.simplify).toBe('allow');
  });

  test('scoped specialist permission keys stay keyed on scoped name', () => {
    const agents = createAgents(solConfig());
    const scoped = agents.find(
      (a) => a.name === 'oracle__orchestrator-glm52-sol',
    );
    const perm = scoped?.config.permission as Record<string, unknown>;

    // question: allow (not councillor), council_session: deny, cancel_task: deny
    expect(perm.question).toBe('allow');
    expect(perm.council_session).toBe('deny');
    expect(perm.cancel_task).toBe('deny');
  });

  test('disabled specialist is skipped and absent from owner prompt', () => {
    // observer is default-disabled; explicitly list it for clarity.
    const config: PluginConfig = {
      disabled_agents: ['observer'],
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            observer: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    };

    const agents = createAgents(config);
    expect(
      agents.find((a) => a.name === 'observer__orchestrator-glm52-sol'),
    ).toBeUndefined();

    const owner = agents.find((a) => a.name === 'orchestrator-glm52-sol');
    expect(owner?.config.prompt ?? '').not.toMatch(/@observer\b/);
  });

  test('name collision between scoped name and custom agent throws', () => {
    const config: PluginConfig = {
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
        // A custom agent that collides with the would-be scoped name.
        'oracle__orchestrator-glm52-sol': {
          model: 'openai/gpt-5.4-mini',
        },
      },
    };

    expect(() => createAgents(config)).toThrow(
      /Scoped specialist name 'oracle__orchestrator-glm52-sol' conflicts/,
    );
  });

  test('global displayName + scoped specialist: owner uses scoped name, others use displayName', () => {
    const config: PluginConfig = {
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: { model: 'openrouter/openai/gpt-5.6-sol', variant: 'high' },
          },
        },
        oracle: { displayName: 'advisor' },
      },
    };

    const agents = createAgents(config);

    const owner = agents.find((a) => a.name === 'orchestrator-glm52-sol');
    const ownerPrompt = owner?.config.prompt ?? '';
    expect(ownerPrompt).toContain('@oracle__orchestrator-glm52-sol');
    expect(ownerPrompt).not.toMatch(/@advisor\b/);
    expect(ownerPrompt).not.toMatch(/@oracle\b/);

    const def = agents.find((a) => a.name === 'orchestrator');
    const defPrompt = def?.config.prompt ?? '';
    expect(defPrompt).toMatch(/@advisor\b/);
    expect(defPrompt).not.toMatch(/@oracle\b/);
    expect(defPrompt).not.toContain('@oracle__orchestrator-glm52-sol');
  });

  test('array model with per-model variant populates _modelArray and clears config.model', () => {
    const config: PluginConfig = {
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: {
              model: [
                { id: 'google/gemini-3-pro', variant: 'high' },
                'openai/gpt-4',
              ],
            },
          },
        },
      },
    };

    const agents = createAgents(config);
    const scoped = agents.find(
      (a) => a.name === 'oracle__orchestrator-glm52-sol',
    );

    expect(scoped?._modelArray).toEqual([
      { id: 'google/gemini-3-pro', variant: 'high' },
      { id: 'openai/gpt-4' },
    ]);
    expect(scoped?.config.model).toBeUndefined();
  });

  test('scoped specialist is hidden and absent from displayName registry', () => {
    const configs = getAgentConfigs(solConfig()) as Record<
      string,
      { hidden?: boolean; displayName?: string }
    >;

    // No displayName key created for the scoped agent.
    expect(
      configs['oracle__orchestrator-glm52-sol'].displayName,
    ).toBeUndefined();
    expect(configs['oracle__orchestrator-glm52-sol'].hidden).toBe(true);
  });

  test('multiple specialists on one orchestrator each get scoped names', () => {
    const config: PluginConfig = {
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
            fixer: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    };

    const agents = createAgents(config);
    expect(
      agents.find((a) => a.name === 'oracle__orchestrator-glm52-sol'),
    ).toBeDefined();
    expect(
      agents.find((a) => a.name === 'fixer__orchestrator-glm52-sol'),
    ).toBeDefined();

    const owner = agents.find((a) => a.name === 'orchestrator-glm52-sol');
    const prompt = owner?.config.prompt ?? '';
    expect(prompt).toContain('@oracle__orchestrator-glm52-sol');
    expect(prompt).toContain('@fixer__orchestrator-glm52-sol');
    expect(prompt).not.toMatch(/@oracle\b/);
    expect(prompt).not.toMatch(/@fixer\b/);
  });
});
