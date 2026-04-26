import { resolve } from "node:path";
import type { RepoTargetConfig } from "./types.js";

export interface ServerConfig {
	apiPort: number;
	publicBaseUrl: string;
	postgresUrl: string;
	redisUrl: string;
	apiToken: string;
	artifactShareSecret: string;
	agentDir: string;
	workerConcurrency: number;
	repos: RepoTargetConfig[];
	bucket:
		| {
				kind: "s3";
				bucket: string;
				endpoint?: string;
				region: string;
		  }
		| {
				kind: "local";
				baseDir: string;
		  };
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

function parseRepos(): RepoTargetConfig[] {
	const raw = process.env.RETURN_BRIEF_REPOS_JSON;
	if (!raw) return [];
	const parsed = JSON.parse(raw) as RepoTargetConfig[];
	if (!Array.isArray(parsed)) {
		throw new Error("RETURN_BRIEF_REPOS_JSON must be a JSON array");
	}
	return parsed;
}

export function loadServerConfig(): ServerConfig {
	const bucketName = process.env.AWS_BUCKET_NAME ?? process.env.RAILWAY_BUCKET_NAME;
	if (bucketName) {
		return {
			apiPort: Number(process.env.PORT ?? 3000),
			publicBaseUrl: process.env.RETURN_BRIEF_PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
			postgresUrl: requireEnv("DATABASE_URL"),
			redisUrl: requireEnv("REDIS_URL"),
			apiToken: requireEnv("AGENT_API_TOKEN"),
			artifactShareSecret: process.env.RETURN_BRIEF_ARTIFACT_SHARE_SECRET ?? requireEnv("AGENT_API_TOKEN"),
			agentDir: process.env.RETURN_BRIEF_AGENT_DIR ?? resolve(process.cwd(), ".runtime", "pi"),
			workerConcurrency: Math.max(1, Number(process.env.RETURN_BRIEF_WORKER_CONCURRENCY ?? 1)),
			repos: parseRepos(),
			bucket: {
				kind: "s3",
				bucket: bucketName,
				endpoint: process.env.AWS_ENDPOINT_URL_S3 ?? process.env.RETURN_BRIEF_BUCKET_ENDPOINT,
				region: process.env.AWS_REGION ?? process.env.RETURN_BRIEF_BUCKET_REGION ?? "us-east-1",
			},
		};
	}

	return {
		apiPort: Number(process.env.PORT ?? 3000),
		publicBaseUrl: process.env.RETURN_BRIEF_PUBLIC_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
		postgresUrl: requireEnv("DATABASE_URL"),
		redisUrl: requireEnv("REDIS_URL"),
		apiToken: requireEnv("AGENT_API_TOKEN"),
		artifactShareSecret: process.env.RETURN_BRIEF_ARTIFACT_SHARE_SECRET ?? requireEnv("AGENT_API_TOKEN"),
		agentDir: process.env.RETURN_BRIEF_AGENT_DIR ?? resolve(process.cwd(), ".runtime", "pi"),
		workerConcurrency: Math.max(1, Number(process.env.RETURN_BRIEF_WORKER_CONCURRENCY ?? 1)),
		repos: parseRepos(),
		bucket: {
			kind: "local",
			baseDir: process.env.RETURN_BRIEF_LOCAL_BUCKET_DIR ?? resolve(process.cwd(), "outputs", "server-artifacts"),
		},
	};
}
