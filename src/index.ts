#!/usr/bin/env bun
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

type RateLimitWindow = {
  usedPercent: number | string;
  windowDurationMins?: number;
  resetsAt?: number;
};

type RateLimits = {
  limitId?: string;
  limitName?: string | null;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: string;
  };
  individualLimit?: unknown;
  planType?: string;
  rateLimitReachedType?: string | null;
};

type ProjectPrompt = {
  id: string;
  title: string;
  prompt: string;
};

type CliCommand = "run" | "status" | "raw" | "doctor-json" | "help";

const timeoutMs = Number.parseInt(process.env.CODEX_STATUS_TIMEOUT ?? "20000", 10);
const scriptPath = fileURLToPath(import.meta.url);
const srcDir = dirname(scriptPath);
const repoRoot = dirname(srcDir);
const promptsPath = join(repoRoot, "data", "project-prompts.json");
const defaultRunRoot = join(repoRoot, "runs");

function usage(exitCode = 0): never {
  const command = process.argv[1]?.split("/").at(-1) ?? "codex-token-burner";
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: ${command} [run [--dry-run]|status [five-hour|weekly]|raw|doctor-json]\n`);
  process.exit(exitCode);
}

function commandExists(command: string): boolean {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function sendJsonLine(stdin: NodeJS.WritableStream, payload: JsonObject): void {
  stdin.write(`${JSON.stringify(payload)}\n`);
}

async function readJsonRpcResponse(
  iterator: AsyncIterator<string>,
  expectedId: number,
): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<{ timeout: true }>((resolve) => {
      timeout = setTimeout(() => resolve({ timeout: true }), remainingMs);
    });
    const next = await Promise.race([iterator.next(), timeoutResult]);
    if (timeout) {
      clearTimeout(timeout);
    }

    if ("timeout" in next) {
      break;
    }

    if (next.done) {
      throw new Error(`Codex app-server closed before response id ${expectedId}.`);
    }

    let payload: JsonObject;
    try {
      payload = JSON.parse(next.value) as JsonObject;
    } catch {
      continue;
    }

    if (payload.id !== expectedId) {
      continue;
    }

    if (typeof payload.error === "object" && payload.error !== null) {
      const error = payload.error as JsonObject;
      throw new Error(String(error.message ?? `Codex app-server returned an error for id ${expectedId}.`));
    }

    return payload;
  }

  throw new Error(`Timed out waiting for Codex app-server response id ${expectedId}.`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

async function fetchCodexRateLimits(): Promise<RateLimits> {
  if (!commandExists("codex")) {
    throw new Error("codex CLI was not found on PATH.");
  }

  const child = spawn("codex", ["-s", "read-only", "-a", "untrusted", "app-server"], {
    cwd: homedir(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const serverError = once(child, "error").then(([error]) => {
    throw error;
  });

  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();

  try {
    sendJsonLine(child.stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-token-burner",
          version: "0.1.0",
        },
      },
    });

    await Promise.race([readJsonRpcResponse(iterator, 1), serverError]);

    sendJsonLine(child.stdin, {
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });

    sendJsonLine(child.stdin, {
      jsonrpc: "2.0",
      id: 2,
      method: "account/rateLimits/read",
      params: {},
    });

    const response = await Promise.race([readJsonRpcResponse(iterator, 2), serverError]);
    const result = response.result as JsonObject | undefined;
    const rateLimits = result?.rateLimits as RateLimits | undefined;

    if (!rateLimits) {
      throw new Error("Codex app-server response was missing result.rateLimits.");
    }

    return rateLimits;
  } catch (error) {
    if (stderr.trim()) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr.trim()}`);
    }
    throw error;
  } finally {
    lines.close();
    child.stdin.end();
    await stopChild(child);
  }
}

function numberValue(value: number | string | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Codex rate limit response did not include a numeric usedPercent.");
  }
  return parsed;
}

function remainingPercent(window: RateLimitWindow | undefined): number {
  const used = numberValue(window?.usedPercent);
  return Math.round(Math.max(0, 100 - used));
}

function usedPercent(window: RateLimitWindow | undefined): number {
  return Math.round(numberValue(window?.usedPercent));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minutesEnv(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function integerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function windowForArgument(rateLimits: RateLimits, argument: string): RateLimitWindow | undefined {
  switch (argument) {
    case "five-hour":
    case "fivehour":
    case "5h":
    case "primary":
      return rateLimits.primary;
    case "weekly":
    case "week":
    case "7d":
    case "secondary":
      return rateLimits.secondary;
    default:
      throw new Error(`unknown status window: ${argument}`);
  }
}

function printStatus(rateLimits: RateLimits, windowArgument?: string): void {
  if (windowArgument) {
    console.log(remainingPercent(windowForArgument(rateLimits, windowArgument)));
    return;
  }

  console.log(`Codex plan: ${rateLimits.planType ?? "unknown"}`);
  console.log(`5h remaining: ${remainingPercent(rateLimits.primary)}% (${usedPercent(rateLimits.primary)}% used)`);
  console.log(`weekly remaining: ${remainingPercent(rateLimits.secondary)}% (${usedPercent(rateLimits.secondary)}% used)`);
}

async function loadProjectPrompts(): Promise<ProjectPrompt[]> {
  const raw = await readFile(promptsPath, "utf8");
  const prompts = JSON.parse(raw) as ProjectPrompt[];

  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error(`No project prompts found in ${promptsPath}.`);
  }

  for (const prompt of prompts) {
    if (!prompt.id || !prompt.title || !prompt.prompt) {
      throw new Error(`Invalid project prompt entry in ${promptsPath}.`);
    }
  }

  return prompts;
}

function pickRandomPrompt(prompts: ProjectPrompt[]): ProjectPrompt {
  return prompts[Math.floor(Math.random() * prompts.length)];
}

function timestampSlug(date = new Date()): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function buildGoalPrompt(project: ProjectPrompt, runDir: string): string {
  return [
    `/goal ${project.title}: ${project.prompt}`,
    "",
    "You are being launched by an unattended Bun runner.",
    "Do not ask clarifying questions or wait for manual approval.",
    "Make reasonable assumptions and keep the work self-contained.",
    "Build the requested app inside a new unique project directory under /tmp.",
    `Runner metadata and logs are stored separately in: ${runDir}`,
    "Avoid credentials, accounts, paid services, or manual setup.",
    "Install dependencies only when needed for the project.",
    "Run relevant verification, fix failures, and finish with concise run instructions.",
  ].join("\n");
}

async function createRunWorkspace(project: ProjectPrompt): Promise<string> {
  const runRoot = process.env.CODEX_RUN_ROOT || defaultRunRoot;
  const suffix = Math.random().toString(36).slice(2, 8);
  const runDir = join(runRoot, `${timestampSlug()}-${project.id}-${suffix}`);

  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "prompt.json"),
    `${JSON.stringify(project, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(runDir, "goal.md"), `${buildGoalPrompt(project, runDir)}\n`, "utf8");

  return runDir;
}

async function runCodexGoal(project: ProjectPrompt, runDir: string): Promise<"completed" | "timed-out" | "failed"> {
  const idleTimeoutMs = minutesEnv("CODEX_RUN_IDLE_TIMEOUT_MINUTES", 20) * 60 * 1000;
  const maxRuntimeMs = minutesEnv("CODEX_RUN_MAX_RUNTIME_MINUTES", 90) * 60 * 1000;
  const outputPath = join(runDir, "codex.log");
  const lastMessagePath = join(runDir, "last-message.md");
  const codexWorkdir = process.env.CODEX_RUN_CODEX_WORKDIR || "/tmp";
  const log = createWriteStream(outputPath, { flags: "a" });
  const modelArgs = process.env.CODEX_RUN_MODEL ? ["--model", process.env.CODEX_RUN_MODEL] : [];
  const args = [
    "--search",
    "exec",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    codexWorkdir,
    "-a",
    "never",
    "-s",
    "danger-full-access",
    "-o",
    lastMessagePath,
    ...modelArgs,
    "-",
  ];

  console.log(`Launching Codex for "${project.title}" in ${runDir}`);
  console.log(`Codex working directory: ${codexWorkdir}`);
  console.log(`Log: ${outputPath}`);

  const child = spawn("codex", args, {
    cwd: runDir,
    env: process.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let lastOutputAt = Date.now();
  const startedAt = Date.now();
  let timedOut = false;

  const writeOutput = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    lastOutputAt = Date.now();
    stream.write(chunk);
    log.write(chunk);
  };

  child.stdout?.on("data", (chunk: Buffer) => writeOutput(chunk, process.stdout));
  child.stderr?.on("data", (chunk: Buffer) => writeOutput(chunk, process.stderr));

  child.stdin.write(buildGoalPrompt(project, runDir));
  child.stdin.end();

  const timer = setInterval(() => {
    if (timedOut) {
      return;
    }

    const now = Date.now();
    const idleFor = now - lastOutputAt;
    const runningFor = now - startedAt;

    if (idleFor >= idleTimeoutMs || runningFor >= maxRuntimeMs) {
      timedOut = true;
      const reason = idleFor >= idleTimeoutMs ? "idle timeout" : "max runtime timeout";
      console.error(`Codex appears frozen (${reason}); terminating process group.`);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      setTimeout(() => {
        if (child.exitCode === null && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 5000).unref();
    }
  }, 5000);

  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code));
    });
  } finally {
    clearInterval(timer);
    log.end();
  }

  if (timedOut) {
    return "timed-out";
  }

  return exitCode === 0 ? "completed" : "failed";
}

async function runAutonomousCycle(cycle = 1): Promise<void> {
  const minRemaining = integerEnv("CODEX_MIN_FIVE_HOUR_REMAINING", 5);
  const maxCycles = integerEnv("CODEX_RUN_MAX_CYCLES", 0);
  const dryRun = process.env.CODEX_RUN_DRY_RUN === "1" || process.argv.includes("--dry-run");

  if (maxCycles > 0 && cycle > maxCycles) {
    console.log(`Reached CODEX_RUN_MAX_CYCLES=${maxCycles}; stopping.`);
    return;
  }

  const rateLimits = await fetchCodexRateLimits();
  const fiveHourRemaining = remainingPercent(rateLimits.primary);

  console.log(`5h remaining: ${fiveHourRemaining}%`);

  if (fiveHourRemaining <= minRemaining) {
    console.log(`Stopping because 5h remaining is at or below ${minRemaining}%.`);
    return;
  }

  const prompts = await loadProjectPrompts();
  const project = pickRandomPrompt(prompts);
  const runDir = await createRunWorkspace(project);

  console.log(`Selected prompt: ${project.title} (${project.id})`);

  if (dryRun) {
    console.log(`Dry run enabled; would launch Codex in ${runDir}.`);
    return;
  }

  const result = await runCodexGoal(project, runDir);
  console.log(`Codex run ended with status: ${result}`);

  const retryDelaySeconds = integerEnv("CODEX_RUN_RETRY_DELAY_SECONDS", 5);
  if (retryDelaySeconds > 0) {
    await sleep(retryDelaySeconds * 1000);
  }

  await runAutonomousCycle(cycle + 1);
}

function runDoctorJson(): never {
  const result = spawnSync("codex", ["doctor", "--json"], {
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = ((args[0] && !args[0].startsWith("--")) ? args[0] : "run") as CliCommand;
  const argument = command === "run" ? undefined : args[1];

  if (command === "-h" || command === "--help" || command === "help") {
    usage(0);
  }

  if (command === "doctor-json") {
    runDoctorJson();
  }

  if (command === "run") {
    await runAutonomousCycle();
    return;
  }

  if (command !== "status" && command !== "raw") {
    usage(2);
  }

  const rateLimits = await fetchCodexRateLimits();

  if (command === "raw") {
    console.log(JSON.stringify(rateLimits, null, 2));
    return;
  }

  printStatus(rateLimits, argument);
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
