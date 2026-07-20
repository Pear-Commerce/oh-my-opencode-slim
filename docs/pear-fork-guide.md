# Pear Fork Guide: OpenCode + oh-my-opencode-slim

> Team onboarding guide for running OpenCode with **Pear's fork** of
> oh-my-opencode-slim (`Pear-Commerce/oh-my-opencode-slim`).
>
> This doc covers setup, daily usage, and — in a dedicated section — the
> **features Pear added on top of upstream**. Those fork features are not in
> the upstream README or `docs/`, so this is the canonical reference for them.

## Table of contents

- [What this is](#what-this-is)
- [Quick start (team setup)](#quick-start-team-setup)
- [Where your config lives](#where-your-config-lives)
- [The agent pantheon](#the-agent-pantheon)
- [Presets and model routing](#presets-and-model-routing)
- [Daily usage](#daily-usage)
- [Pear fork additions](#pear-fork-additions)
  - [1. `orchestrator_class` custom agents](#1-orchestrator_class-custom-agents)
  - [2. Deepwork-wakeup hook](#2-deepwork-wakeup-hook)
  - [3. `WAKEUP_MODEL` pinning to glm-5p2](#3-wakeup_model-pinning-to-glm-5p2)
  - [4. Fixer-review hook](#4-fixer-review-hook)
  - [5. Councillor file-upload persistence](#5-councillor-file-upload-persistence)
- [Council (upstream feature we use)](#council-upstream-feature-we-use)
- [Building and updating the fork](#building-and-updating-the-fork)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)

---

## What this is

**oh-my-opencode-slim** is an OpenCode plugin that gives you a team of
specialized agents (Orchestrator, Explorer, Oracle, Librarian, Designer,
Fixer, Observer, Council) under one coordinator. Instead of one model doing
everything, each part of a job routes to the agent best suited for it,
balancing quality, speed, and cost.

**Pear runs a fork** of the upstream plugin
([`alvinunreal/oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim))
at
[`Pear-Commerce/oh-my-opencode-slim`](https://github.com/Pear-Commerce/oh-my-opencode-slim).
The fork carries **38 commits** by Eric Martell that add five features on top
of upstream v2.0.x — most notably **orchestrator-class custom agents** and an
**event-driven deepwork wakeup loop with convergence gates**. Those additions
are documented in [Pear fork additions](#pear-fork-additions) below.

> **Version note:** the fork's `package.json` reports `2.0.3` while upstream
> npm is at `2.2.4`. The fork diverged after upstream commit `9229174` and
> carries Pear-specific commits on top of that point. Do **not** `bunx
> oh-my-opencode-slim@latest install` — that pulls upstream npm and you lose
> the fork features. Use the local build path in
> [Quick start](#quick-start-team-setup).

---

## Quick start (team setup)

The fork ships an installer (`install.sh` at the repo root) that builds the
plugin and drops the three OpenCode config files into `~/.config/opencode/`
for you. It works with **both OpenCode Desktop (macOS .app) and the opencode
CLI** — Desktop reads the same config location, and the script detects which
one you run and tailors the next-steps accordingly.

### Prerequisites

- **OpenCode** — either the [Desktop app](https://opencode.ai) or the `opencode` CLI. The installer does not require the CLI.
- **[Bun](https://bun.sh)** — required to build the plugin (`curl -fsSL https://bun.sh/install | bash`).
- **Provider credentials** — Pear uses two providers:
  - **OpenRouter** — Anthropic, OpenAI, Google models (Claude Opus/Sonnet, GPT-5.5, Gemini). OAuth.
  - **Fireworks AI** — GLM 5.2, DeepSeek, Kimi, Qwen. API key (`FIREWORKS_API_KEY`) or OAuth.

### Install

```bash
git clone git@github.com:Pear-Commerce/oh-my-opencode-slim.git ~/oh-my-opencode-slim
cd ~/oh-my-opencode-slim
./install.sh
```

That's it. `install.sh` will:

1. Build the plugin (`bun install && bun run build`) → `dist/index.js`.
2. Back up any existing config in `~/.config/opencode/` to `<name>.bak.<timestamp>`.
3. Install three files into `~/.config/opencode/`:
   - `opencode.jsonc` — generated from `pear-config/opencode.jsonc.template` with the plugin path patched to `<your clone>/dist/index.js`
   - `oh-my-opencode-slim.json` — copied from `pear-config/` (presets, custom agents, council)
   - `tui.json` — copied from `pear-config/`
4. Print the manual next steps (auth + restart), tailored to Desktop or CLI.

Other forms:

```bash
./install.sh --dry-run       # preview, write nothing
./install.sh --help          # full usage
./install.sh /path/to/clone  # install from a different clone directory
```

### Next steps (after install)

**If you run OpenCode Desktop** (the installer detects this automatically):

1. **Quit Desktop completely (Cmd-Q) and reopen it** — config is loaded once at startup.
2. Sign in to OpenRouter and Fireworks AI via Desktop's in-app auth (Settings / account), or `export FIREWORKS_API_KEY` in your shell profile.
3. Confirm `fireworks-ai/accounts/fireworks/models/glm-5p2` is visible in the Desktop model picker (refresh if not).

**If you run the opencode CLI:**

```bash
opencode auth login
opencode models --refresh
```

Confirm `fireworks-ai/accounts/fireworks/models/glm-5p2` appears, then restart `opencode`.

### Verify

Launch OpenCode, start a session, and you should see the Orchestrator as the
default agent with the specialist pantheon available via `@agentName`.

### Updating later

```bash
cd ~/oh-my-opencode-slim
git pull
./install.sh
```

The installer re-runs safely — it backs up your existing config before
overwriting. If you've customized `oh-my-opencode-slim.json` by hand, your
customizations will be in the `.bak` file; diff it against the freshly
installed one to re-apply.

### Manual install (fallback)

If you can't run `install.sh`, the equivalent steps are:

```bash
git clone git@github.com:Pear-Commerce/oh-my-opencode-slim.git ~/oh-my-opencode-slim
cd ~/oh-my-opencode-slim
bun install && bun run build
mkdir -p ~/.config/opencode
sed "s|__OMO_PLUGIN_PATH__|$(pwd)/dist/index.js|g" pear-config/opencode.jsonc.template > ~/.config/opencode/opencode.jsonc
cp pear-config/oh-my-opencode-slim.json ~/.config/opencode/
cp pear-config/tui.json ~/.config/opencode/
```

> The `provider.fireworks-ai.models` entry for `glm-5p2` in `opencode.jsonc`
> is **required** — it tells OpenCode the GLM 5.2 model exists on Fireworks
> with a 1M context window. Without it, model resolution fails for any agent
> or preset that references `fireworks-ai/accounts/fireworks/models/glm-5p2`.
> The installer handles this for you; only worry about it if you install
> manually or hand-edit the config.


---

## Where your config lives

Two files matter. Keep them straight:

| File | Scope | What goes here |
|---|---|---|
| `~/.config/opencode/opencode.jsonc` | OpenCode core | Providers, the GLM 5.2 model definition, top-level `model`/`small_model`, **plugin path** (points at the fork build), built-in agent enable/disable, LSP |
| `~/.config/opencode/oh-my-opencode-slim.json` | OMO-slim plugin | Active `preset`, all `presets`, `disabled_agents`, **custom agents** (incl. `orchestrator_class`), `council` block |

The **canonical source** for both (plus `tui.json`) is the `pear-config/`
directory in this fork repo. `install.sh` copies them into
`~/.config/opencode/` (generating `opencode.jsonc` from
`pear-config/opencode.jsonc.template` with your clone's plugin path
substituted). Edit the copies in `pear-config/` if you want changes to
propagate to the whole team on the next `./install.sh`.

Other locations (Pear does **not** currently use these, but they exist):

| Path | Purpose | Pear status |
|---|---|---|
| `~/.config/opencode/agent/<name>.md` | OpenCode-native custom agent files | empty — unused |
| `~/.config/opencode/oh-my-opencode-slim/<agent>.md` | Full prompt replacement for a built-in agent | does not exist — unused |
| `~/.config/opencode/oh-my-opencode-slim/<agent>_append.md` | Append-only prompt tuning for a built-in agent | does not exist — unused |
| `~/.config/opencode/skills/<name>/SKILL.md` | Installed skills | present: `clonedeps`, `codemap`, `deepwork`, `oh-my-opencode-slim`, `reflect`, `simplify`, `worktrees` |
| `~/.config/opencode/tui.json` | TUI plugin registration | registers `oh-my-opencode-slim` |

> If you want to tweak a built-in agent's prompt (e.g. add a project-specific
> rule to the Orchestrator), prefer
> `~/.config/opencode/oh-my-opencode-slim/orchestrator_append.md` over
> replacing the whole prompt. See the `oh-my-opencode-slim` skill for details.

---

## The agent pantheon

The plugin ships eight built-in agents. You talk to the **Orchestrator**; it
delegates to the rest.

| Agent | Role | When the Orchestrator calls it |
|---|---|---|
| **orchestrator** | Workflow manager — plans, delegates, reconciles, verifies | You talk to this directly |
| **explorer** | Fast codebase recon (glob/grep/AST) | "What exists before planning" |
| **librarian** | External docs & web research | Library/API questions, version-specific behavior |
| **oracle** | Architecture, risk, debugging strategy, code review | High-stakes decisions, persistent bugs, review |
| **designer** | UI/UX design & implementation | User-facing interfaces, polish, responsive |
| **fixer** | Bounded mechanical implementation | Well-scoped edits, parallel folder-scoped work |
| **observer** | Vision-capable observation | Disabled in Pear config (`disabled_agents: ["observer"]`) |
| **council** | Multi-LLM consensus | Critical decisions needing multiple perspectives |

You can also call any specialist directly with `@agentName <task>`.

> The full agent descriptions, stats, and delegation rules live in the
> Orchestrator's system prompt. See
> [upstream's Meet the Pantheon](../README.md#meet-the-pantheon) for the
> marketing version.

---

## Presets and model routing

A **preset** is a named bundle of per-agent model/skill/MCP settings. Exactly
one preset is active at a time (`"preset": "orchestrator-glm52"`). Switch
presets at runtime with `/preset <name>` (see
[`docs/preset-switching.md`](preset-switching.md)).

### Pear's presets

Pear's `oh-my-opencode-slim.json` defines five presets. They share the same
specialist routing and differ only in the **orchestrator model/variant**:

| Preset | Orchestrator model | Variant |
|---|---|---|
| `orchestrator-glm52` *(active)* | `fireworks-ai/accounts/fireworks/models/glm-5p2` | — |
| `orchestrator-gpt55-medium` | `openrouter/openai/gpt-5.5` | medium |
| `orchestrator-gpt55-high` | `openrouter/openai/gpt-5.5` | high |
| `orchestrator-gpt55-xhigh` | `openrouter/openai/gpt-5.5` | xhigh |
| `fireworks-openrouter` | `openrouter/openai/gpt-5.5` | medium |

Every preset uses the same specialist layout:

- **oracle** → `openrouter/anthropic/claude-opus-4.8` (variant `xhigh`),
  skills `["simplify"]`
- **council** → `openrouter/anthropic/claude-sonnet-4.6` (variant `high`)
- **librarian** → `fireworks-ai/.../glm-5p2`, MCPs `websearch`, `context7`,
  `gh_grep`
- **explorer** → `fireworks-ai/.../glm-5p2`
- **designer** → `openrouter/anthropic/claude-sonnet-4.6` (variant `high`)
- **fixer** → `fireworks-ai/.../glm-5p2`

The pattern: **cheap/fast GLM 5.2 for scouting and mechanical work**, **Sonnet
4.6 for design and council**, **Opus 4.8 for architecture/review**, and the
**orchestrator model is the dial you turn** (GLM for cost, GPT-5.5 at
medium/high/xhigh for harder coordination).

### Variants

`variant` is a free-form reasoning-effort string passed through to the
provider. Common values: `low`, `medium`, `high`, `xhigh`, `max`. Not every
provider honors every value; OpenRouter maps them per model.

### Tuning a preset

Edit `~/.config/opencode/oh-my-opencode-slim.json`:

```jsonc
{
  "preset": "orchestrator-glm52",
  "presets": {
    "orchestrator-glm52": {
      "orchestrator": {
        "model": "fireworks-ai/accounts/fireworks/models/glm-5p2",
        "skills": ["*"],
        "mcps": ["*", "!context7"]
      },
      "oracle": { "model": "openrouter/anthropic/claude-opus-4.8", "variant": "xhigh", "skills": ["simplify"], "mcps": [] }
      // ...librarian, explorer, designer, fixer, council
    }
  }
}
```

`skills: ["*"]` = all skills; `["*", "!codemap"]` = all except codemap.
`mcps` follows the same allow/exclude syntax. Restart OpenCode after editing.

---

## Daily usage

- **Start a session**: run `opencode`, pick the Orchestrator (default), and
  describe the task. The Orchestrator plans and delegates.
- **Manual delegation**: `@explorer find all OfferDOMInsertion usages`,
  `@librarian check Next.js App Router docs`, `@fixer rename X across src/`.
- **Switch preset**: `/preset orchestrator-gpt55-high` for a harder
  coordination task; switch back to `orchestrator-glm52` for cost.
- **Background work**: the Orchestrator dispatches specialists as background
  tasks and reconciles them when they finish. Watch them live via
  [Multiplexer integration](multiplexer-integration.md) (tmux/zellij panes).
- **Deepwork loops**: for long multi-phase work, the Orchestrator uses the
  `deepwork` skill (in `~/.config/opencode/skills/deepwork/`) + the fork's
  [deepwork-wakeup hook](#2-deepwork-wakeup-hook) to keep looping until a
  convergence gate passes.

---

## Pear fork additions

These five features are **not in upstream**. They live in the fork's source
and are enabled by the Pear config. Each is tagged with the commit that
introduced it.

### 1. `orchestrator_class` custom agents

> Commit `7f46d51` — the fork's headline feature.

**Problem:** upstream, every entry under `agents.<name>` in
`oh-my-opencode-slim.json` becomes a **subagent** (a specialist the
Orchestrator delegates to). You could not define a *second orchestrator* —
e.g. a cheaper orchestrator model you switch to for cost-sensitive work —
because custom agents always ran as subagents with subagent permissions.

**What the fork adds:** a boolean `orchestrator_class` flag on agent
overrides. When `true`, the custom agent is registered as a **primary
orchestrator-class agent** — it gets the full Orchestrator prompt,
permissions (`cancel_task: allow`, `skill: { '*': 'allow' }`), skills, hooks,
and `primary` mode. It appears in the agent picker alongside the built-in
Orchestrator.

**Schema** (`src/config/schema.ts:83`):

```ts
orchestrator_class: z.boolean().optional().describe(
  'When true on a custom agent, register it as an orchestrator-class primary agent with orchestrator prompt, permissions, skills, and hooks.',
)
```

**How to add one** — in `~/.config/opencode/oh-my-opencode-slim.json`:

```jsonc
{
  "agents": {
    "orchestrator-deepseek-high": {
      "orchestrator_class": true,
      "model": "fireworks-ai/accounts/fireworks/models/deepseek-v4-pro",
      "variant": "high",
      "skills": ["*"],
      "mcps": ["*", "!context7"]
    }
  }
}
```

**Pear's orchestrator-class agents** (all five defined in the config):

| Agent | Model | Variant |
|---|---|---|
| `orchestrator-gpt55-medium` | `openrouter/openai/gpt-5.5` | medium |
| `orchestrator-gpt55-high` | `openrouter/openai/gpt-5.5` | high |
| `orchestrator-gpt55-xhigh` | `openrouter/openai/gpt-5.5` | xhigh |
| `orchestrator-deepseek-high` | `fireworks-ai/.../deepseek-v4-pro` | high |
| `orchestrator-glm52` | `fireworks-ai/.../glm-5p2` | — |

Switch between them in the agent picker to change which orchestrator model
runs the session without touching presets.

**Important interaction:** the [deepwork-wakeup hook](#2-deepwork-wakeup-hook)
only manages sessions whose agent `isOrchestratorClassAgent(...)` — i.e. the
built-in `orchestrator` **plus** any custom agent with `orchestrator_class:
true`. If you want a custom orchestrator to participate in deepwork loops, it
must carry this flag.

### 2. Deepwork-wakeup hook

> Commits `060e088` (initial) through `26f4007` — ~25 follow-up fixes. Source:
> `src/hooks/deepwork-wakeup/index.ts` (~1137 lines).

**Problem:** OpenCode's `/loop` is manual. When an Orchestrator delegates
background work and goes idle, it sits there until you nudge it. For long
multi-phase work (deepwork), you want it to **wake itself** when background
jobs finish, reconcile the results, and keep going until the work is done —
without burning expensive orchestrator tokens on idle polling.

**What the fork adds:** an event-driven + periodic wakeup hook that acts as
an automated `/loop` for orchestrator-class sessions. It does three things:

1. **Background-completion wake (event-driven).** When a delegated background
   task finishes and its parent orchestrator is idle, the hook wakes the
   orchestrator with a reconcile prompt so it can integrate the result and
   continue. This always works, even with the periodic poll disabled.

2. **Periodic done-check (optional, disabled in Pear's build).** Every
   `intervalMs` (default 120s), if the orchestrator is still idle and has a
   history of background work, the hook asks a one-word "are you done?"
   question. On "no", it sends a continue prompt. **Pear disables this**
   (`periodicDoneCheck: false` in `src/index.ts:351`) because after a manual
   abort OpenCode emits only `session.idle` (no abort event), so the hook
   cannot distinguish "stopped by user" from "finished a turn" and would
   re-execute a thread the user just stopped. Event-driven wakes and one-shot
   gate firing still work with the periodic poll off.

3. **Convergence gates (loop termination).** Replaces the model yes/no
   done-check with a machine-checkable termination condition for "get this
   passable according to X standard" loops. Two gate types:

   - **`command` gate** — runs a shell command. Exit 0 = pass (stop the
     loop), non-zero = fail (send a continue prompt with the gate output).
    - **`adjudicator` gate** — spawns a visible Oracle subagent session with a prompt
      (and optional file attachments) that must respond `PASS` or `FAIL` on its first
      line. Uses the configured Oracle model by default. Files can be attached for
      document review. The adjudicator runs as a child session of the orchestrator and
      injects a `noReply` start notification into the orchestrator ("⎖ Gate adjudicator
      running — ctrl+x ↓ to watch") so you can follow along in the TUI and verify it
      hasn't stalled. On a `PASS`/`FAIL` response the session is left intact for review;
      it's aborted only on timeout/stall to stop the runaway generation.

   Gates are set via the **`set_loop_gate` tool** (available to
   orchestrator-class agents) and **persist to disk** at
   `<project>/.slim/deepwork/gates/<sessionID>.json` so they survive process
   restarts. Clear a gate with `type: "clear"` to revert to the model
   yes/no done-check.

**Safety rails** (from the source):

- The periodic timer only starts for sessions that have actually launched
  background work (or have a gate set), so idle chat sessions are never polled.
- The gate/done-check never fires while background jobs are still running —
  the event-driven wake handles completion.
- A 2-minute cooldown (`GATE_FAIL_COOLDOWN_MS`) applies after a gate FAIL
  before re-firing, and also after background activity, to avoid hot-looping.
- The gate does not fire while unreconciled terminal background work exists.
- Default gate execution timeout is 10 minutes (`DEFAULT_GATE_TIMEOUT_MS =
  600_000`) — LLM reviews can be slow.

**Using it day-to-day:** you usually don't. The Orchestrator turns it on
itself when it enters a deepwork loop (see the `deepwork` skill). If you want
a convergence loop ("keep fixing until `bun test` passes" or "keep refining
until the reviewer approves"), tell the Orchestrator to set a command or
adjudicator gate and let it run.

### 3. `WAKEUP_MODEL` pinning to glm-5p2

> Commit `b12a9d7`. Source: `src/index.ts:119-127` and `:352-401`.

**Problem:** the deepwork-wakeup hook sends its own prompts (done-check,
reconcile, continue, gate-fail) via `promptAsync`. If those used the session's
configured orchestrator model, every periodic poll would burn GPT-5.5 / Opus
tokens — expensive and wasteful for a one-word "are you done?" turn.

**What the fork adds:** a hardcoded constant:

```ts
const WAKEUP_MODEL = 'fireworks-ai/accounts/fireworks/models/glm-5p2';
```

All wakeup prompts are forced to GLM 5.2 (cheap, 1M context) regardless of
the session's orchestrator model. The **agent** is still resolved per-session
(so the correct Orchestrator system prompt and context are injected); only
the **model** is pinned. After a restart, the agent is recovered by querying
the session's first message with an `agent` field.

**To change the wakeup model:** edit `WAKEUP_MODEL` in `src/index.ts` and
`bun run build`. This is why the `glm-5p2` model definition in
`opencode.jsonc` (under `provider.fireworks-ai.models`) is required even if
your active preset doesn't use GLM as the orchestrator.

### 4. Fixer-review hook

> Commit `106b143`. Source: `src/hooks/fixer-review/`.

**What the fork adds:** when a Fixer produces a non-trivial diff, the hook
auto-spawns an **Oracle review** of the change. The Oracle model is resolved
from the active preset's `oracle` agent config. This gives fixer-driven
changes a lightweight automatic review pass without the Orchestrator having
to explicitly delegate one.

### 5. Councillor file-upload persistence

> Commit `0b987dd`. Source: `src/council/` and `src/hooks/council-details/`.

**What the fork adds:** file uploads are persisted and councillor details are
deterministically preserved across the council flow. Practically: when you
attach files to a council run, they survive the councillor round-trip and the
councillor attribution in the synthesized report is stable. No config
required — it's automatic.

---

## Council (upstream feature we use)

The council system itself is **upstream**, not a fork addition. Pear
configures it in `oh-my-opencode-slim.json`:

```jsonc
{
  "council": {
    "default_preset": "default",
    "timeout": 1800000,
    "presets": {
      "default": {
        "architect":     { "model": "openrouter/anthropic/claude-opus-4.8", "variant": "xhigh", "prompt": "Focus on architecture, maintainability, data integrity, and long-term risk." },
        "implementer":   { "model": "openrouter/openai/gpt-5.5", "variant": "xhigh", "prompt": "Focus on practical implementation, correctness, and delivery trade-offs." },
        "oss-reviewer":  { "model": "fireworks-ai/accounts/fireworks/models/deepseek-v4-pro", "variant": "high", "prompt": "Focus on independent code review, simplification, and edge cases." }
      }
    }
  }
}
```

Three councillors run in parallel (architect / implementer / oss-reviewer),
each on a different model, and the Council agent synthesizes their answers.
Timeout is 30 minutes. See [`docs/council.md`](council.md) for the full
upstream guide.

---

## Building and updating the fork

To update the fork and re-install:

```bash
cd ~/oh-my-opencode-slim
git pull origin master
./install.sh
```

`install.sh` rebuilds (`bun install && bun run build`) and re-installs the
config files (backing up any existing ones). Restart OpenCode afterward to
load the new `dist/index.js`.

The build chain is `clean:dist → build:plugin (bun) → build:cli → tsc
--emitDeclarationOnly → generate-schema`. `dist/` is what OpenCode loads; the
schema at `oh-my-opencode-slim.schema.json` is regenerated from the zod
schemas by `scripts/generate-schema.ts`.

If you change source by hand (e.g. edit `WAKEUP_MODEL` in `src/index.ts`),
rebuild with `bun run build` and restart OpenCode. You do not need to
re-run `install.sh` unless you also want to refresh the config files.

### Syncing with upstream

The fork has no `upstream` git remote configured. To pull in upstream
changes:

```bash
git remote add upstream https://github.com/alvinunreal/oh-my-opencode-slim.git
git fetch upstream
# Merge or rebase upstream/master onto your branch, resolve conflicts carefully
# — the fork touches schema.ts, agents/index.ts, config/utils.ts, index.ts,
# and the deepwork-wakeup hook, so expect conflicts there.
git rebase upstream/master
./install.sh
```

The fork is currently **behind upstream by version** (fork `2.0.3` vs upstream
`2.2.4`), so a sync will bring in real upstream changes — review the upstream
changelog first.

---

## Troubleshooting

- **OpenCode won't start after a config edit** — opencode hard-fails on
  invalid config. Use escape hatches:
  - `OPENCODE_DISABLE_PROJECT_CONFIG=1` to skip project-local config
  - `OPENCODE_CONFIG=/path/to/file.json` to load an explicit config
  - `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` to skip external skill scans
  See the `customize-opencode` skill for the full list.
- **`glm-5p2` model not found** — you're missing the
  `provider.fireworks-ai.models` entry in `opencode.jsonc` (see
  [Quick start](#quick-start-team-setup)), or your Fireworks API key isn't
  set. Run `opencode models --refresh`.
- **Plugin changes not taking effect** — you edited source but didn't
  `bun run build`, or you built but didn't restart OpenCode. Both are required.
- **Orchestrator isn't waking up in a deepwork loop** — confirm the session's
  agent is orchestrator-class (built-in `orchestrator` or a custom agent with
  `orchestrator_class: true`). The wakeup hook only manages those. The
  periodic done-check is intentionally disabled; event-driven wakes (on
  background completion) and gates still work.
- **Gate keeps re-firing** — that's expected on FAIL. There's a 2-minute
  cooldown between gate failures. Clear the gate with `set_loop_gate` type
  `"clear"` to stop the loop.
- **A built-in agent's behavior is wrong** — prefer adding an
  `~/.config/opencode/oh-my-opencode-slim/<agent>_append.md` file (append
  tuning) over replacing the whole prompt. Restart OpenCode after.

---

## Further reading

Upstream docs in this repo's `docs/` folder (all upstream, not Pear-specific):

- [`configuration.md`](configuration.md) — full config reference
- [`background-orchestration.md`](background-orchestration.md) — how
  background delegation works
- [`preset-switching.md`](preset-switching.md) — `/preset` runtime switching
- [`council.md`](council.md) — multi-LLM council guide
- [`multiplexer-integration.md`](multiplexer-integration.md) — tmux/zellij
  panes per agent
- [`skills.md`](skills.md) — skill system
- [`installation.md`](installation.md) — upstream installer (remember: use
  the local fork build, not `bunx ...@latest`)

Pear skills relevant to this setup (in `~/.config/opencode/skills/`):

- `oh-my-opencode-slim` — configuring the plugin (presets, agents, prompts)
- `customize-opencode` — OpenCode core config schema and escape hatches
- `deepwork` — the deepwork loop workflow the wakeup hook automates
- `worktrees` — isolated coding lanes (use with deepwork)
- `reflect` — reviewing sessions for reusable improvements
