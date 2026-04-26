import { Worker } from "bullmq";
import { createPool, ReturnBriefStore } from "./db.js";
import { RUN_QUEUE_NAME, PREVIEW_QUEUE_NAME, ReturnBriefQueue } from "./queue.js";
import { LocalArtifactStore, S3ArtifactStore, type ArtifactStore } from "./artifacts.js";
import { executePreviewWatch, executeRun, type ExecutionContext } from "./executor.js";
import type { ServerConfig } from "./config.js";

export async function startWorker(config: ServerConfig): Promise<{
	close(): Promise<void>;
}> {
	const pool = createPool(config.postgresUrl);
	const store = new ReturnBriefStore(pool);
	await store.migrate();
	await store.syncConfiguredRepos(config.repos);
	const queue = new ReturnBriefQueue(config.redisUrl);
	const artifactStore: ArtifactStore =
		config.bucket.kind === "s3"
			? new S3ArtifactStore(config.bucket.bucket, config.bucket.region, config.bucket.endpoint)
			: new LocalArtifactStore(config.bucket.baseDir);
	const activeSessions = new Map<string, import("@mariozechner/pi-coding-agent").AgentSession>();
	const concurrency = 1;
	const executionContext: ExecutionContext = {
		store,
		artifactStore,
		queue,
		agentDir: config.agentDir,
		activeSessions,
		publicBaseUrl: config.publicBaseUrl,
	};

	const runWorker = new Worker(
		RUN_QUEUE_NAME,
		async (job) => {
			await executeRun(executionContext, job.data);
		},
		{
			connection: queue.bullConnection,
			// Pi sessions in this worker mutate process cwd/env for the active repo workspace.
			// Scale horizontally with more worker replicas rather than raising in-process concurrency.
			concurrency,
		},
	);
	const previewWorker = new Worker(
		PREVIEW_QUEUE_NAME,
		async (job) => {
			await executePreviewWatch(executionContext, job.data);
		},
		{
			connection: queue.bullConnection,
			concurrency: 1,
		},
	);
	const cancelSubscriber = await queue.subscribeCancels(async (runId) => {
		const session = activeSessions.get(runId);
		if (session) {
			await session.abort().catch(() => undefined);
		}
	});

	return {
		async close() {
			cancelSubscriber.disconnect();
			await Promise.all([runWorker.close(), previewWorker.close(), queue.close(), pool.end()]);
		},
	};
}
