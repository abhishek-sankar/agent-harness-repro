import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalArtifactStore } from "./artifacts.js";

test("LocalArtifactStore copies files into the run-scoped artifact directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "return-brief-artifacts-"));
	const source = join(root, "report.json");
	await writeFile(source, JSON.stringify({ ok: true }));
	const store = new LocalArtifactStore(join(root, "bucket"));

	const artifact = await store.putFile("run-123", "report_json", source, "application/json");
	assert.equal(artifact.kind, "report_json");
	assert.ok(artifact.storageKey.startsWith("runs/run-123/"));

	const download = await store.getDownload({
		id: artifact.id,
		runId: "run-123",
		kind: artifact.kind,
		storageKey: artifact.storageKey,
		mimeType: artifact.mimeType,
		sizeBytes: artifact.sizeBytes,
		checksum: artifact.checksum,
		createdAt: new Date().toISOString(),
	});
	assert.equal(download.type, "file");
});

