import { loadServerConfig } from "../config.js";
import { buildApiServer } from "../api.js";
import { createPool, ReturnBriefStore } from "../db.js";
import { ReturnBriefQueue } from "../queue.js";
import { LocalArtifactStore, S3ArtifactStore } from "../artifacts.js";

const config = loadServerConfig();
const pool = createPool(config.postgresUrl);
const store = new ReturnBriefStore(pool);
await store.migrate();
await store.syncConfiguredRepos(config.repos);
const queue = new ReturnBriefQueue(config.redisUrl);
const artifactStore =
	config.bucket.kind === "s3"
		? new S3ArtifactStore(config.bucket.bucket, config.bucket.region, config.bucket.endpoint)
		: new LocalArtifactStore(config.bucket.baseDir);

const server = await buildApiServer({ store, queue, artifactStore, config });
await server.listen({ host: "0.0.0.0", port: config.apiPort });

