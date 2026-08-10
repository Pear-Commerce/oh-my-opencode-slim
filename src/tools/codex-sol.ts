import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type ToolContext,
  type ToolDefinition,
  tool,
} from '@opencode-ai/plugin';
import { crossSpawn } from '../utils/compat';

const CODEX_SOL_RELAY_AGENT = 'oracle__orchestrator-glm52-sol';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_STATE_FILE = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
  'opencode',
  'storage',
  'oh-my-opencode-slim',
  'codex-sol-sessions.json',
);

export interface CodexSolSessionResult {
  answer: string;
  sessionID?: string;
}

export interface CodexSolRunOptions {
  cwd: string;
  model?: string;
  command?: string;
  timeoutMs?: number;
  reasoningEffort?: string;
  signal?: AbortSignal;
  sessionID?: string;
}

export type CodexSolSessionRunner = (
  prompt: string,
  options: CodexSolRunOptions,
) => Promise<CodexSolSessionResult>;

export interface CodexSolSessionStore {
  get(openCodeSessionID: string): Promise<string | undefined>;
  set(openCodeSessionID: string, codexSessionID: string): Promise<void>;
}

class JsonCodexSolSessionStore implements CodexSolSessionStore {
  private state?: Record<string, string>;
  private writeQueue = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(openCodeSessionID: string): Promise<string | undefined> {
    await this.load();
    return this.state?.[openCodeSessionID];
  }

  async set(openCodeSessionID: string, codexSessionID: string): Promise<void> {
    await this.load();
    this.state = { ...this.state, [openCodeSessionID]: codexSessionID };
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const temporary = `${this.path}.tmp`;
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
        await rename(temporary, this.path);
      });
    await this.writeQueue;
  }

  private async load(): Promise<void> {
    if (this.state) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<
        string,
        unknown
      >;
      this.state = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && entry[1].length > 0,
        ),
      );
    } catch {
      this.state = {};
    }
  }
}

export function createCodexSolSessionStore(
  path = DEFAULT_STATE_FILE,
): CodexSolSessionStore {
  return new JsonCodexSolSessionStore(path);
}

const defaultSessionStore = createCodexSolSessionStore();

export async function runCodexSolSession(
  prompt: string,
  options: CodexSolRunOptions,
): Promise<CodexSolSessionResult> {
  const command = options.command ?? 'codex';
  const model = options.model ?? DEFAULT_MODEL;
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = options.sessionID
    ? [
        command,
        'exec',
        'resume',
        '--json',
        '--model',
        model,
        '--config',
        `model_reasoning_effort="${reasoningEffort}"`,
        options.sessionID,
        '-',
      ]
    : [
        command,
        'exec',
        '--json',
        '--color',
        'never',
        '--model',
        model,
        '--config',
        `model_reasoning_effort="${reasoningEffort}"`,
        '--cd',
        options.cwd,
        '-',
      ];
  const child = crossSpawn(args, {
    cwd: options.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  child.proc.stdin?.end(prompt);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Codex CLI timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_, reject) => {
    if (!options.signal) return;
    abortHandler = () => reject(new Error('Codex CLI run was aborted'));
    if (options.signal.aborted) abortHandler();
    else options.signal.addEventListener('abort', abortHandler, { once: true });
  });

  try {
    const exitCode = await Promise.race([child.exited, timeout, aborted]);
    const [stdout, stderr] = await Promise.all([
      child.stdout(),
      child.stderr(),
    ]);
    let sessionID = options.sessionID;
    let answer = '';
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string };
        };
        if (event.type === 'thread.started' && event.thread_id) {
          sessionID = event.thread_id;
        }
        if (
          event.type === 'item.completed' &&
          event.item?.type === 'agent_message' &&
          typeof event.item.text === 'string'
        ) {
          answer = event.item.text;
        }
      } catch {
        // Ignore non-JSON diagnostics on stdout.
      }
    }
    if (exitCode !== 0) {
      throw new Error(
        `Codex CLI exited with code ${exitCode}: ${stderr.trim() || 'no output'}`,
      );
    }
    if (!answer.trim()) {
      throw new Error(
        `Codex CLI completed without an answer${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
    }
    return { answer: answer.trim(), sessionID };
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

export function createCodexSolTool(options?: {
  command?: string;
  model?: string;
  reasoningEffort?: string;
  runner?: CodexSolSessionRunner;
  sessionStore?: CodexSolSessionStore;
  resolvePrompt?: (
    requestedPrompt: string,
    context: ToolContext,
  ) => string | Promise<string>;
}): ToolDefinition {
  const runner = options?.runner ?? runCodexSolSession;
  const sessionStore = options?.sessionStore ?? defaultSessionStore;
  return tool({
    description:
      'Send the exact user prompt through a persistent local Codex CLI conversation and return the Codex answer.',
    args: {
      prompt: tool.schema
        .string()
        .min(1)
        .describe('The exact user prompt to send to Codex without changes'),
    },
    async execute(args, ctx) {
      if (ctx.agent !== CODEX_SOL_RELAY_AGENT) {
        throw new Error(
          `codex_sol can only be used by ${CODEX_SOL_RELAY_AGENT}`,
        );
      }
      const prompt = options?.resolvePrompt
        ? await options.resolvePrompt(args.prompt, ctx)
        : args.prompt;
      const result = await runner(prompt, {
        command: options?.command,
        cwd: ctx.directory,
        model: options?.model ?? DEFAULT_MODEL,
        reasoningEffort: options?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        signal: ctx.abort,
        sessionID: await sessionStore.get(ctx.sessionID),
      });
      if (result.sessionID) {
        await sessionStore.set(ctx.sessionID, result.sessionID);
      }
      return result.answer;
    },
  });
}
