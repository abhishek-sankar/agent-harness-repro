import { createReadStream } from "node:fs";
import Fastify from "fastify";
import type { ArtifactStore } from "./artifacts.js";
import type { ReturnBriefStore } from "./db.js";
import type { ReturnBriefQueue } from "./queue.js";
import type { ServerConfig } from "./config.js";
import type { RunRequestInput } from "./types.js";
import { loadSnapshot } from "../data-source.js";

function requireBearer(authHeader: string | undefined, token: string): void {
	if (!authHeader || authHeader !== `Bearer ${token}`) {
		throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
	}
}

export async function buildApiServer(opts: {
	store: ReturnBriefStore;
	queue: ReturnBriefQueue;
	artifactStore: ArtifactStore;
	config: ServerConfig;
}) {
	const app = Fastify({ logger: true });

	app.addHook("preHandler", async (request) => {
		if (request.url === "/healthz") return;
		requireBearer(request.headers.authorization, opts.config.apiToken);
	});

	app.get("/healthz", async () => ({ ok: true }));

	app.get("/api/repos", async () => {
		return await opts.store.listRepos();
	});

	app.get("/api/repos/:id/prs", async (request) => {
		const repo = await opts.store.getRepo((request.params as { id: string }).id);
		if (!repo) throw Object.assign(new Error("Repo not found"), { statusCode: 404 });
		return (await loadSnapshot(repo.repo)).prs;
	});

	app.get("/api/repos/:id/issues", async (request) => {
		const repo = await opts.store.getRepo((request.params as { id: string }).id);
		if (!repo) throw Object.assign(new Error("Repo not found"), { statusCode: 404 });
		return (await loadSnapshot(repo.repo)).issues;
	});

	app.post("/api/runs", async (request, reply) => {
		const body = request.body as RunRequestInput;
		const repo = await opts.store.getRepo(body.repoId);
		if (!repo) return reply.status(404).send({ error: "repo_not_found" });
		const run = await opts.store.createRun(body);
		await opts.store.appendRunEvent(run.id, "submitted", { mode: body.mode, repoId: body.repoId, input: body });
		await opts.queue.enqueueRun(run.id);
		return reply.status(202).send(await opts.store.getRunView(run.id, opts.config.publicBaseUrl));
	});

	app.get("/api/runs", async () => {
		const runs = await opts.store.listRuns();
		const views = await Promise.all(runs.map(async (run) => await opts.store.getRunView(run.id, opts.config.publicBaseUrl)));
		return views.filter((run): run is NonNullable<typeof run> => run !== null);
	});

	app.get("/api/runs/:id", async (request, reply) => {
		const run = await opts.store.getRunView((request.params as { id: string }).id, opts.config.publicBaseUrl);
		if (!run) return reply.status(404).send({ error: "run_not_found" });
		return run;
	});

	app.get("/api/runs/:id/events", async (request, reply) => {
		const runId = (request.params as { id: string }).id;
		const run = await opts.store.getRun(runId);
		if (!run) return reply.status(404).send({ error: "run_not_found" });

		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		});
		reply.raw.write(": connected\n\n");
		let cursor = Number(request.headers["last-event-id"] ?? 0);
		const poll = async () => {
			const events = await opts.store.listRunEvents(runId, cursor);
			for (const event of events) {
				cursor = event.id;
				reply.raw.write(`id: ${event.id}\n`);
				reply.raw.write(`event: ${event.type}\n`);
				reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
			}
		};
		await poll();
		const interval = setInterval(() => {
			void poll();
		}, 1000);
		request.raw.on("close", () => clearInterval(interval));
		return reply;
	});

	app.post("/api/runs/:id/cancel", async (request, reply) => {
		const runId = (request.params as { id: string }).id;
		const run = await opts.store.requestCancellation(runId);
		if (!run) return reply.status(404).send({ error: "run_not_found" });
		await opts.store.appendRunEvent(run.id, "status", { status: run.status, cancelRequestedAt: run.cancelRequestedAt });
		await opts.queue.publishCancel(run.id);
		await opts.queue.removeQueuedRun(run.id);
		return await opts.store.getRunView(run.id, opts.config.publicBaseUrl);
	});

	app.get("/api/artifacts/:id/download", async (request, reply) => {
		const artifact = await opts.store.getArtifact((request.params as { id: string }).id);
		if (!artifact) return reply.status(404).send({ error: "artifact_not_found" });
		const download = await opts.artifactStore.getDownload(artifact);
		if (download.type === "redirect") {
			return reply.redirect(download.url);
		}
		reply.header("Content-Type", download.mimeType);
		return reply.send(createReadStream(download.path));
	});

	return app;
}
