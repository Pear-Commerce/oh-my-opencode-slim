import { describe, expect, test } from 'bun:test';
import {
  AgentOverrideConfigSchema,
  PluginConfigSchema,
  SpecialistNameSchema,
} from './schema';

describe('SpecialistNameSchema', () => {
  test('accepts the six specialist names', () => {
    for (const name of [
      'oracle',
      'librarian',
      'explorer',
      'designer',
      'fixer',
      'observer',
    ]) {
      expect(SpecialistNameSchema.safeParse(name).success).toBe(true);
    }
  });

  test('rejects council, councillor, orchestrator, and bogus names', () => {
    for (const name of ['council', 'councillor', 'orchestrator', 'bogus']) {
      expect(SpecialistNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe('PluginConfigSchema specialists validation', () => {
  test('specialists with key oracle on orchestrator_class:true agent parses', () => {
    const result = PluginConfigSchema.safeParse({
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
    });

    expect(result.success).toBe(true);
  });

  test('specialists key council is rejected', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            council: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('specialists key councillor is rejected', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            councillor: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('specialists key orchestrator is rejected', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            orchestrator: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('specialists key bogus is rejected', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            bogus: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('specialists on a built-in oracle entry is rejected', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        oracle: {
          model: 'openai/gpt-5.5',
          specialists: {
            oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('specialists on a non-orchestrator_class custom agent is rejected', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        janitor: {
          model: 'openai/gpt-5.4-mini',
          specialists: {
            oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('specialists on a preset oracle entry is rejected', () => {
    const result = PluginConfigSchema.safeParse({
      presets: {
        sol: {
          oracle: {
            model: 'openai/gpt-5.5',
            specialists: {
              oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('specialists on a preset orchestrator_class:true entry is allowed', () => {
    const result = PluginConfigSchema.safeParse({
      presets: {
        sol: {
          'orchestrator-glm52-sol': {
            orchestrator_class: true,
            model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
            specialists: {
              oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('nested specialists inside a specialist value is rejected (.strict)', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: {
              model: 'openrouter/openai/gpt-5.6-sol',
              specialists: {
                oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
              },
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('nested orchestrator_class inside a specialist value is rejected (.strict)', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: {
              model: 'openrouter/openai/gpt-5.6-sol',
              orchestrator_class: true,
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('nested displayName inside a specialist value is rejected (.strict)', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: {
              model: 'openrouter/openai/gpt-5.6-sol',
              displayName: 'advisor',
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('nested orchestratorPrompt inside a specialist value is rejected (.strict)', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: {
              model: 'openrouter/openai/gpt-5.6-sol',
              orchestratorPrompt: '@oracle\n- Role: x',
            },
          },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  test('specialists may be an empty map', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {},
        },
      },
    });

    expect(result.success).toBe(true);
  });

  test('specialists may include multiple specialist keys', () => {
    const result = PluginConfigSchema.safeParse({
      agents: {
        'orchestrator-glm52-sol': {
          orchestrator_class: true,
          model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
          specialists: {
            oracle: { model: 'openrouter/openai/gpt-5.6-sol' },
            librarian: { model: 'openrouter/openai/gpt-5.6-sol' },
            fixer: { model: 'openrouter/openai/gpt-5.6-sol' },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('AgentOverrideConfigSchema specialists field', () => {
  test('accepts specialists on a custom orchestrator_class override', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      orchestrator_class: true,
      model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
      specialists: {
        oracle: { model: 'openrouter/openai/gpt-5.6-sol', variant: 'high' },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specialists?.oracle?.model).toBe(
        'openrouter/openai/gpt-5.6-sol',
      );
      expect(result.data.specialists?.oracle?.variant).toBe('high');
    }
  });

  test('specialists value with array model parses', () => {
    const result = AgentOverrideConfigSchema.safeParse({
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
    });

    expect(result.success).toBe(true);
  });

  test('specialists value rejects empty model array', () => {
    const result = AgentOverrideConfigSchema.safeParse({
      orchestrator_class: true,
      model: 'fireworks-ai/accounts/fireworks/models/glm-5p2',
      specialists: {
        oracle: { model: [] },
      },
    });

    expect(result.success).toBe(false);
  });
});
