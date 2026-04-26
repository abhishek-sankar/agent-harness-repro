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

function terminateProcessTree(child: ReturnType<typeof spawn>): void {
	if (child.exitCode !== null) return;
	try {
		if (child.pid) {
			process.kill(-child.pid, "SIGTERM");
			return;
		}
	} catch {
		// Fall back to killing just the direct child below.
	}
	child.kill("SIGTERM");
}

function forceKillProcessTree(child: ReturnType<typeof spawn>): void {
	if (child.exitCode !== null) return;
	try {
		if (child.pid) {
			process.kill(-child.pid, "SIGKILL");
			return;
		}
	} catch {
		// Fall back to killing just the direct child below.
	}
	child.kill("SIGKILL");
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
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.unref();
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	try {
		await waitForReady(url, child, () => ({ stdout, stderr }));
		return {
			baseUrl: `http://127.0.0.1:${repo.port}`,
			async stop() {
				terminateProcessTree(child);
				await new Promise((resolve) => setTimeout(resolve, 1000));
				if (child.exitCode === null) forceKillProcessTree(child);
			},
		};
	} catch (error) {
		terminateProcessTree(child);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		if (child.exitCode === null) forceKillProcessTree(child);
		throw error;
	}
}

async function waitForReady(
	url: string,
	child: ReturnType<typeof spawn>,
	getOutput: () => { stdout: string; stderr: string },
): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 60_000) {
		if (child.exitCode !== null) {
			const { stdout, stderr } = getOutput();
			throw new Error(`App process exited before readiness check succeeded: ${stderr || stdout}`);
		}
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// Continue polling.
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const { stdout, stderr } = getOutput();
	throw new Error(`Timed out waiting for app readiness at ${url}. stdout: ${stdout}. stderr: ${stderr}`);
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
