# OpenCode Go Preset

`opencode-go` is a bundled generated preset for users who want to run the
Pantheon agents through OpenCode Go models instead of the default OpenAI setup.

The installer generates both `openai` and `opencode-go` presets. OpenAI stays
active by default unless you select OpenCode Go during install or switch to it
later.

Because the `opencode-go` preset uses GLM-5.1 for Orchestrator and GLM is not
multimodal, installing with `--preset=opencode-go` also enables the Observer
agent and configures it with `opencodex/kimi-k2p7-code` for visual analysis.

## Install with OpenCode Go Active

```bash
bunx oh-my-opencode-slim@latest install --preset=opencode-go
```

Then authenticate and refresh models:

```bash
opencode auth login
opencode models --refresh
```

## Switch at Runtime

If both presets are already in your config, switch from inside OpenCode:

```text
/preset opencode-go
```

See [Preset Switching](preset-switching.md) for the full runtime switching
workflow. If you originally installed with the default OpenAI preset, also add
`"disabled_agents": []` to your config and restart OpenCode so Observer is
available before switching to `opencode-go`.

`disabled_agents` is global, not per-preset. If you later switch back to OpenAI
and restart while keeping `"disabled_agents": []`, Observer will remain enabled
and use the default Observer model unless you configure one explicitly.

## Bundled Model Mapping

The generated `opencode-go` preset maps each specialist to a model tuned for its
role:

| Agent | Model |
|-------|-------|
| Orchestrator | `opencodex/glm-5p2` |
| Oracle | `opencodex/deepseek-v4-flash-0731` (`max`) |
| Council | `opencodex/deepseek-v4-flash-0731` (`high`) |
| Librarian | `opencodex/glm-5p2` |
| Explorer | `opencodex/glm-5p2` |
| Designer | `opencodex/kimi-k2p7-code` (`medium`) |
| Fixer | `opencodex/deepseek-v4-flash-0731` (`high`) |
| Observer | `opencodex/kimi-k2p7-code` |

## Generated Config Shape

Your generated config includes `opencode-go` under `presets` and activates it by
setting the top-level `preset` field:

```jsonc
{
  "preset": "opencode-go",
  "disabled_agents": [],
  "presets": {
    "opencode-go": {
      "orchestrator": { "model": "opencodex/glm-5p2" },
      "oracle": {
        "model": "opencodex/deepseek-v4-flash-0731",
        "variant": "max"
      },
      "council": {
        "model": "opencodex/deepseek-v4-flash-0731",
        "variant": "high"
      },
      "librarian": { "model": "opencodex/glm-5p2" },
      "explorer": { "model": "opencodex/glm-5p2" },
      "designer": {
        "model": "opencodex/kimi-k2p7-code",
        "variant": "medium"
      },
      "fixer": {
        "model": "opencodex/deepseek-v4-flash-0731",
        "variant": "high"
      },
      "observer": { "model": "opencodex/kimi-k2p7-code" }
    }
  }
}
```

For the complete configuration reference, see
[Configuration](configuration.md).
