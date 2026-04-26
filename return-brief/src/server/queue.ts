import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import type { QueueRunJob } from "./types.js";

export const RUN_QUEUE_NAME = "return-brief:runs";
export const PREVIEW_QUEUE_NAME = "return-brief:preview-watch";
const CANCEL_CHANNEL = "return-brief:cancel";

export class ReturnBriefQueue {
	private readonly connection: IORedis;
	private readonly publisher: IORedis;
	readonly runs: Queue<QueueRunJob>;
	readonly preview: Queue<QueueRunJob>;

	constructor(redisUrl: string) {
		this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
		this.publisher = new IORedis(redisUrl, { maxRetriesPerRequest: null });
		this.runs = new Queue<QueueRunJob>(RUN_QUEUE_NAME, { connection: this.connection });
		this.preview = new Queue<QueueRunJob>(PREVIEW_QUEUE_NAME, { connection: this.connection });
	}

	get bullConnection(): IORedis {
		return this.connection;
	}

	async enqueueRun(runId: string, opts: JobsOptions = {}): Promise<void> {
		await this.runs.add(runId, { runId }, { removeOnComplete: 200, removeOnFail: 200, ...opts });
	}

	async enqueuePreviewWatch(runId: string, delayMs = 0): Promise<void> {
		await this.preview.add(`preview:${runId}`, { runId }, { delay: delayMs, removeOnComplete: 200, removeOnFail: 200 });
	}

	async removeQueuedRun(runId: string): Promise<void> {
		const job = await this.runs.getJob(runId);
		await job?.remove().catch(() => undefined);
	}

	async publishCancel(runId: string): Promise<void> {
		await this.publisher.publish(CANCEL_CHANNEL, runId);
	}

	async subscribeCancels(onCancel: (runId: string) => void | Promise<void>): Promise<IORedis> {
		const subscriber = new IORedis(this.connection.options);
		await subscriber.subscribe(CANCEL_CHANNEL);
		subscriber.on("message", (_channel, message) => {
			void onCancel(message);
		});
		return subscriber;
	}

	async close(): Promise<void> {
		await Promise.all([this.runs.close(), this.preview.close(), this.connection.quit(), this.publisher.quit()]);
	}
}
