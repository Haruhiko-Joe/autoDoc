import { Codex } from "@openai/codex-sdk";
import type { CodexOptions } from "@openai/codex-sdk";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_PROFILE_TEMPLATES = {
  prupdater: `
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"
personality = "pragmatic"
`,
  decomposer: `
sandbox_mode = "read-only"
model_reasoning_effort = "xhigh"
approval_policy = "never"
personality = "pragmatic"
`,
  knowledge: `
sandbox_mode = "read-only"
model_reasoning_effort = "high"
approval_policy = "never"
personality = "pragmatic"
`,
  flowanalyzer: `
sandbox_mode = "read-only"
model_reasoning_effort = "xhigh"
approval_policy = "never"
personality = "pragmatic"
`,
  writer: `
sandbox_mode = "read-only"
model_reasoning_effort = "xhigh"
approval_policy = "never"
personality = "pragmatic"
`,
  scaffold: `
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"
personality = "none"
`,
  reviewer: `
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "read-only"
personality = "pragmatic"
approvals_reviewer = "user"
`,
  planner: `
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"
personality = "none"
`,
  checker: `
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "read-only"
personality = "pragmatic"
`,
  benchmark: `
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"
personality = "pragmatic"
`,
} as const;

export type CodexProfileName = keyof typeof CODEX_PROFILE_TEMPLATES;

type CodexConfig = NonNullable<CodexOptions["config"]>;

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function resolveCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  const home = os.homedir();
  const expanded = raw
    ? raw.replace(/^~(?=$|\/)/, home)
    : path.join(home, ".codex");
  const resolved = path.resolve(expanded);
  process.env.CODEX_HOME = resolved;
  return resolved;
}

export async function ensureCodexProfileFiles(
  profiles: readonly CodexProfileName[] = Object.keys(CODEX_PROFILE_TEMPLATES) as CodexProfileName[],
): Promise<{ codexHome: string; created: string[]; existing: string[] }> {
  const codexHome = resolveCodexHome();
  await mkdir(codexHome, { recursive: true });

  const created: string[] = [];
  const existing: string[] = [];

  for (const profile of profiles) {
    const filePath = profileFilePath(codexHome, profile);
    const exists = await stat(filePath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (exists) {
      existing.push(filePath);
      continue;
    }

    await writeFile(filePath, `${CODEX_PROFILE_TEMPLATES[profile].trim()}\n`);
    created.push(filePath);
  }

  return { codexHome, created, existing };
}

export async function createCodexClient(profile: CodexProfileName, config: CodexConfig): Promise<Codex> {
  await ensureCodexProfileFiles([profile]);
  return new Codex({
    codexPathOverride: await ensureCodexProfileWrapper(profile),
    config,
  });
}

function profileFilePath(codexHome: string, profile: CodexProfileName): string {
  return path.join(codexHome, `${profile}.config.toml`);
}

async function ensureCodexProfileWrapper(profile: CodexProfileName): Promise<string> {
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    throw new Error(`Invalid Codex profile name: ${profile}`);
  }

  const codexHome = resolveCodexHome();
  const wrapperDir = path.join(codexHome, ".tmp", "acceed-codex-profiles");
  const wrapperPath = path.join(wrapperDir, `${profile}.mjs`);
  const script = renderWrapperScript(profile, resolveCodexCliPath());

  await mkdir(wrapperDir, { recursive: true });
  const current = await readFile(wrapperPath, "utf-8").catch(() => "");
  if (current !== script) {
    await writeFile(wrapperPath, script);
  }
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function resolveCodexCliPath(): string {
  const sdkPackageDir = findNodeModulePackageDir("@openai/codex-sdk");
  if (!sdkPackageDir) {
    throw new Error("Cannot find @openai/codex-sdk package directory");
  }
  const sdkRequire = createRequire(path.join(sdkPackageDir, "dist", "index.js"));
  const codexPackagePath = sdkRequire.resolve("@openai/codex/package.json");
  return path.join(path.dirname(codexPackagePath), "bin", "codex.js");
}

function findNodeModulePackageDir(packageName: string): string | null {
  const parts = packageName.split("/");
  const starts = [
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ];

  for (const start of starts) {
    let dir = path.resolve(start);
    while (true) {
      const packageJson = path.join(dir, "node_modules", ...parts, "package.json");
      if (existsSync(packageJson)) return path.dirname(realpathSync(packageJson));

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

function renderWrapperScript(profile: CodexProfileName, codexCliPath: string): string {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";

const profile = ${JSON.stringify(profile)};
const codexCliPath = ${JSON.stringify(codexCliPath)};
const originalArgs = process.argv.slice(2);
const args = originalArgs[0] === "exec"
  ? ["exec", "--profile", profile, ...originalArgs.slice(1)]
  : ["--profile", profile, ...originalArgs];

const child = spawn(process.execPath, [codexCliPath, ...args], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
`;
}
