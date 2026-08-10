import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { crossSpawn } from '../utils/compat';

const CODEX_SOL_ORCHESTRATOR = 'orchestrator-glm52-sol';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_TIMEOUT_MS = 900_000;

export interface CodexSolRunOptions {
  cwd: string;
  model?: string;
  command?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CodexSolRunner = (
  prompt: string,
  options: CodexSolRunOptions,
) => Promise<string>;

export async function runCodexSol(
  prompt: string,
  options: CodexSolRunOptions,
): Promise<string> {
  const command = options.command ?? 'codex';
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = crossSpawn(
    [
      command,
      'exec',
      '--ephemeral',
      '--color',
      'never',
      '--model',
      model,
      '--cd',
      options.cwd,
      '-',
    ],
    {
      cwd: options.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    },
  );

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
    if (options.signal.aborted) {
      abortHandler();
      return;
    }
    options.signal.addEventListener('abort', abortHandler, { once: true });
  });

  try {
    const exitCode = await Promise.race([child.exited, timeout, aborted]);
    const [stdout, stderr] = await Promise.all([
      child.stdout(),
      child.stderr(),
    ]);
    const answer = stdout.trim();
    if (exitCode !== 0) {
      throw new Error(
        `Codex CLI exited with code ${exitCode}: ${stderr.trim() || answer || 'no output'}`,
      );
    }
    if (!answer) {
      throw new Error(
        `Codex CLI completed without an answer${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
    }
    return answer;
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler && options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

export function createCodexSolTool(options?: {
  model?: string;
  runner?: CodexSolRunner;
}): ToolDefinition {
  const runner = options?.runner ?? runCodexSol;
  return tool({
    description:
      'Run the Sol reasoning lane through the local Codex CLI and return its answer without creating an OpenCode subagent.',
    args: {
      prompt: tool.schema
        .string()
        .min(1)
        .describe('The exact oracle delegation prompt to send to Codex'),
    },
    async execute(args, ctx) {
      if (ctx.agent !== CODEX_SOL_ORCHESTRATOR) {
        throw new Error(
          `codex_sol can only be used by ${CODEX_SOL_ORCHESTRATOR}`,
        );
      }
      return runner(args.prompt, {
        cwd: ctx.directory,
        model: options?.model ?? DEFAULT_MODEL,
        signal: ctx.abort,
      });
    },
  });
}
