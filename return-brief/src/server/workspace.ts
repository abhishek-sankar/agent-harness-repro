import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { RepoTargetConfig } from "./types.js";

export interface ManagedWorkspace {
	path: string;
	cleanup(): Promise<void>;
}

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ManagedApp {
	baseUrl: string;
	stop(): Promise<void>;
}

function withGithubToken(cloneUrl: string): string {
	const token = process.env.GITHUB_TOKEN;
	if (!token) return cloneUrl;
	if (!cloneUrl.startsWith("https://github.com/")) return cloneUrl;
	return cloneUrl.replace("https://", `https://x-access-token:${token}@`);
}

export async function createWorkspace(repo: RepoTargetConfig): Promise<ManagedWorkspace> {
	const baseDir = await mkdtemp(join(tmpdir(), "return-brief-"));
	const workspacePath = join(baseDir, "workspace");
	await runShell(`git clone --branch ${shellQuote(repo.defaultBranch)} --single-branch ${shellQuote(withGithubToken(repo.cloneUrl))} ${shellQuote(workspacePath)}`, process.cwd(), process.env);
	return {
		path: workspacePath,
		async cleanup() {
			await rm(baseDir, { recursive: true, force: true });
		},
	};
}

export async function runShell(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
	const shell = resolveShell(env);
	return await new Promise<CommandResult>((resolve, reject) => {
		const child = spawn(shell, ["-lc", command], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const result = { code: code ?? 1, stdout, stderr };
			if ((code ?? 1) !== 0) {
				reject(new Error(`Command failed (${command}): ${stderr || stdout}`));
				return;
			}
			resolve(result);
		});
	});
}

export async function startWorkspaceApp(repo: RepoTargetConfig, cwd: string, env: NodeJS.ProcessEnv): Promise<ManagedApp> {
	if (!repo.startCommand) {
		throw new Error(`Repo ${repo.id} does not define startCommand`);
	}
	const url = `http://127.0.0.1:${repo.port}${repo.healthcheckPath ?? "/"}`;
	const child = spawn(resolveShell(env), ["-lc", repo.startCommand], {
		cwd,
		env: { ...env, PORT: String(repo.port) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	child.stdout.resume();
	await waitForReady(url, child, stderr);
	return {
		baseUrl: `http://127.0.0.1:${repo.port}`,
		async stop() {
			if (child.exitCode !== null) return;
			child.kill("SIGTERM");
			await new Promise((resolve) => setTimeout(resolve, 1000));
			if (child.exitCode === null) child.kill("SIGKILL");
		},
	};
}

async function waitForReady(url: string, child: ReturnType<typeof spawn>, stderr: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 60_000) {
		if (child.exitCode !== null) {
			throw new Error(`App process exited before readiness check succeeded: ${stderr}`);
		}
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// Continue polling.
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(`Timed out waiting for app readiness at ${url}`);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolveShell(env: NodeJS.ProcessEnv): string {
	const configured = env.SHELL;
	if (configured && existsSync(configured)) return configured;
	if (existsSync("/bin/bash")) return "/bin/bash";
	if (existsSync("/usr/bin/bash")) return "/usr/bin/bash";
	if (existsSync("/bin/sh")) return "/bin/sh";
	return "sh";
}
