import { loadServerConfig } from "../config.js";
import { startWorker } from "../worker.js";

const runtime = await startWorker(loadServerConfig());

const shutdown = async () => {
	await runtime.close();
	process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

