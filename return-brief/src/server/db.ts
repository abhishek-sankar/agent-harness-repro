import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type {
	ApiRunView,
	ArtifactRecord,
	RepoTargetConfig,
	RunEventRecord,
	RunRecord,
	RunRequestInput,
	RunStatus,
} from "./types.js";

const MIGRATIONS = [
	`
	CREATE TABLE IF NOT EXISTS repos (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		github_repo TEXT NOT NULL,
		clone_url TEXT NOT NULL,
		default_branch TEXT NOT NULL,
		config JSONB NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
	`,
	`
	CREATE TABLE IF NOT EXISTS runs (
		id TEXT PRIMARY KEY,
		repo_id TEXT NOT NULL REFERENCES repos(id),
		mode TEXT NOT NULL,
		status TEXT NOT NULL,
		input JSONB NOT NULL DEFAULT '{}'::jsonb,
		branch TEXT,
		draft_pr_url TEXT,
		preview_url TEXT,
		error_message TEXT,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		started_at TIMESTAMPTZ,
		finished_at TIMESTAMPTZ,
		cancel_requested_at TIMESTAMPTZ
	);
	`,
	`
	CREATE TABLE IF NOT EXISTS run_events (
		id BIGSERIAL PRIMARY KEY,
		run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		event_type TEXT NOT NULL,
		payload JSONB NOT NULL DEFAULT '{}'::jsonb,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
	`,
	`
	CREATE TABLE IF NOT EXISTS artifacts (
		id TEXT PRIMARY KEY,
		run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		storage_key TEXT NOT NULL,
		mime_type TEXT NOT NULL,
		size_bytes BIGINT NOT NULL,
		checksum TEXT,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);
	`,
	`CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);`,
	`CREATE INDEX IF NOT EXISTS idx_run_events_run_id_id ON run_events(run_id, id);`,
	`CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);`,
];

function toRun(row: Record<string, unknown>): RunRecord {
	return {
		id: String(row.id),
		repoId: String(row.repo_id),
		mode: String(row.mode) as RunRecord["mode"],
		status: String(row.status) as RunStatus,
		input: (row.input ?? {}) as Record<string, unknown>,
		branch: row.branch ? String(row.branch) : null,
		draftPrUrl: row.draft_pr_url ? String(row.draft_pr_url) : null,
		previewUrl: row.preview_url ? String(row.preview_url) : null,
		errorMessage: row.error_message ? String(row.error_message) : null,
		createdAt: new Date(String(row.created_at)).toISOString(),
		startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
		finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
		cancelRequestedAt: row.cancel_requested_at ? new Date(String(row.cancel_requested_at)).toISOString() : null,
	};
}

function toArtifact(row: Record<string, unknown>): ArtifactRecord {
	return {
		id: String(row.id),
		runId: String(row.run_id),
		kind: String(row.kind) as ArtifactRecord["kind"],
		storageKey: String(row.storage_key),
		mimeType: String(row.mime_type),
		sizeBytes: Number(row.size_bytes),
		checksum: row.checksum ? String(row.checksum) : null,
		createdAt: new Date(String(row.created_at)).toISOString(),
	};
}

export class ReturnBriefStore {
	constructor(private readonly pool: Pool) {}

	async migrate(): Promise<void> {
		for (const sql of MIGRATIONS) {
			await this.pool.query(sql);
		}
	}

	async syncConfiguredRepos(repos: RepoTargetConfig[]): Promise<void> {
		for (const repo of repos) {
			await this.pool.query(
				`
				INSERT INTO repos (id, name, github_repo, clone_url, default_branch, config)
				VALUES ($1, $2, $3, $4, $5, $6::jsonb)
				ON CONFLICT (id) DO UPDATE SET
					name = EXCLUDED.name,
					github_repo = EXCLUDED.github_repo,
					clone_url = EXCLUDED.clone_url,
					default_branch = EXCLUDED.default_branch,
					config = EXCLUDED.config,
					updated_at = NOW()
				`,
				[repo.id, repo.name, repo.repo, repo.cloneUrl, repo.defaultBranch, JSON.stringify(repo)],
			);
		}
	}

	async listRepos(): Promise<Array<{ id: string; name: string; repo: string; defaultBranch: string; config: RepoTargetConfig }>> {
		const result = await this.pool.query(`SELECT id, name, github_repo, default_branch, config FROM repos ORDER BY name ASC`);
		return result.rows.map((row: Record<string, unknown>) => ({
			id: String(row.id),
			name: String(row.name),
			repo: String(row.github_repo),
			defaultBranch: String(row.default_branch),
			config: row.config as RepoTargetConfig,
		}));
	}

	async getRepo(id: string): Promise<{ id: string; name: string; repo: string; defaultBranch: string; config: RepoTargetConfig } | null> {
		const result = await this.pool.query(
			`SELECT id, name, github_repo, default_branch, config FROM repos WHERE id = $1`,
			[id],
		);
		const row = result.rows[0];
		if (!row) return null;
		return {
			id: String(row.id),
			name: String(row.name),
			repo: String(row.github_repo),
			defaultBranch: String(row.default_branch),
			config: row.config as RepoTargetConfig,
		};
	}

	async createRun(input: RunRequestInput): Promise<RunRecord> {
		const id = randomUUID();
		const result = await this.pool.query(
			`
			INSERT INTO runs (id, repo_id, mode, status, input)
			VALUES ($1, $2, $3, 'queued', $4::jsonb)
			RETURNING *
			`,
			[id, input.repoId, input.mode, JSON.stringify(input)],
		);
		return toRun(result.rows[0] as Record<string, unknown>);
	}

	async getRun(id: string): Promise<RunRecord | null> {
		const result = await this.pool.query(`SELECT * FROM runs WHERE id = $1`, [id]);
		const row = result.rows[0];
		return row ? toRun(row as Record<string, unknown>) : null;
	}

	async listRuns(limit = 50): Promise<RunRecord[]> {
		const result = await this.pool.query(`SELECT * FROM runs ORDER BY created_at DESC LIMIT $1`, [limit]);
		return result.rows.map((row: Record<string, unknown>) => toRun(row));
	}

	async patchRun(id: string, patch: Partial<{
		status: RunStatus;
		branch: string | null;
		draftPrUrl: string | null;
		previewUrl: string | null;
		errorMessage: string | null;
		startedAt: Date | null;
		finishedAt: Date | null;
		cancelRequestedAt: Date | null;
	}>): Promise<RunRecord> {
		const sets: string[] = [];
		const values: unknown[] = [];
		let index = 1;
		const push = (column: string, value: unknown) => {
			sets.push(`${column} = $${index}`);
			values.push(value);
			index += 1;
		};
		if (patch.status !== undefined) push("status", patch.status);
		if (patch.branch !== undefined) push("branch", patch.branch);
		if (patch.draftPrUrl !== undefined) push("draft_pr_url", patch.draftPrUrl);
		if (patch.previewUrl !== undefined) push("preview_url", patch.previewUrl);
		if (patch.errorMessage !== undefined) push("error_message", patch.errorMessage);
		if (patch.startedAt !== undefined) push("started_at", patch.startedAt);
		if (patch.finishedAt !== undefined) push("finished_at", patch.finishedAt);
		if (patch.cancelRequestedAt !== undefined) push("cancel_requested_at", patch.cancelRequestedAt);
		if (sets.length === 0) {
			const current = await this.getRun(id);
			if (!current) throw new Error(`Run ${id} not found`);
			return current;
		}
		values.push(id);
		const result = await this.pool.query(
			`UPDATE runs SET ${sets.join(", ")} WHERE id = $${index} RETURNING *`,
			values,
		);
		return toRun(result.rows[0] as Record<string, unknown>);
	}

	async appendRunEvent(runId: string, type: string, payload: Record<string, unknown>): Promise<RunEventRecord> {
		const result = await this.pool.query(
			`
			INSERT INTO run_events (run_id, event_type, payload)
			VALUES ($1, $2, $3::jsonb)
			RETURNING *
			`,
			[runId, type, JSON.stringify(payload)],
		);
		const row = result.rows[0] as Record<string, unknown>;
		return {
			id: Number(row.id),
			runId: String(row.run_id),
			type: String(row.event_type),
			payload: row.payload as Record<string, unknown>,
			createdAt: new Date(String(row.created_at)).toISOString(),
		};
	}

	async listRunEvents(runId: string, afterId = 0, limit = 200): Promise<RunEventRecord[]> {
		const result = await this.pool.query(
			`
			SELECT * FROM run_events
			WHERE run_id = $1 AND id > $2
			ORDER BY id ASC
			LIMIT $3
			`,
			[runId, afterId, limit],
		);
		return result.rows.map((row: Record<string, unknown>) => ({
			id: Number(row.id),
			runId: String(row.run_id),
			type: String(row.event_type),
			payload: row.payload as Record<string, unknown>,
			createdAt: new Date(String(row.created_at)).toISOString(),
		}));
	}

	async requestCancellation(runId: string): Promise<RunRecord | null> {
		const current = await this.getRun(runId);
		if (!current) return null;
		if (current.status === "queued") {
			return this.patchRun(runId, { status: "cancelled", cancelRequestedAt: new Date(), finishedAt: new Date() });
		}
		if (current.status === "running") {
			return this.patchRun(runId, { status: "cancelling", cancelRequestedAt: new Date() });
		}
		return current;
	}

	async getArtifacts(runId: string): Promise<ArtifactRecord[]> {
		const result = await this.pool.query(`SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC`, [runId]);
		return result.rows.map((row: Record<string, unknown>) => toArtifact(row));
	}

	async upsertArtifact(input: Omit<ArtifactRecord, "createdAt">): Promise<ArtifactRecord> {
		const result = await this.pool.query(
			`
			INSERT INTO artifacts (id, run_id, kind, storage_key, mime_type, size_bytes, checksum)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (id) DO UPDATE SET
				kind = EXCLUDED.kind,
				storage_key = EXCLUDED.storage_key,
				mime_type = EXCLUDED.mime_type,
				size_bytes = EXCLUDED.size_bytes,
				checksum = EXCLUDED.checksum
			RETURNING *
			`,
			[input.id, input.runId, input.kind, input.storageKey, input.mimeType, input.sizeBytes, input.checksum],
		);
		return toArtifact(result.rows[0] as Record<string, unknown>);
	}

	async getArtifact(id: string): Promise<ArtifactRecord | null> {
		const result = await this.pool.query(`SELECT * FROM artifacts WHERE id = $1`, [id]);
		const row = result.rows[0];
		return row ? toArtifact(row as Record<string, unknown>) : null;
	}

	async getRunView(id: string, publicBaseUrl: string): Promise<ApiRunView | null> {
		const client = await this.pool.connect();
		try {
			const runResult = await client.query(
				`
				SELECT
					r.*,
					repos.name AS repo_name,
					repos.github_repo,
					repos.default_branch
				FROM runs r
				JOIN repos ON repos.id = r.repo_id
				WHERE r.id = $1
				`,
				[id],
			);
			const row = runResult.rows[0];
			if (!row) return null;
			const run = toRun(row as Record<string, unknown>);
			const artifacts = await this.getArtifacts(id);
			const report = artifacts.find((artifact) => artifact.kind === "report_md") ?? artifacts.find((artifact) => artifact.kind === "report_json");
			const assistantResponse = artifacts.find((artifact) => artifact.kind === "assistant_response");
			const returnVideo = artifacts.find((artifact) => artifact.kind === "return_video");
			const implementationDemo = artifacts.find((artifact) => artifact.kind === "implementation_demo");
			return {
				...run,
				repo: {
					id: String(row.repo_id),
					name: String(row.repo_name),
					repo: String(row.github_repo),
					defaultBranch: String(row.default_branch),
				},
				artifacts,
				links: {
					reportUrl: report ? `${publicBaseUrl}/api/artifacts/${report.id}/download` : undefined,
					assistantResponseUrl: assistantResponse ? `${publicBaseUrl}/api/artifacts/${assistantResponse.id}/download` : undefined,
					returnBriefVideoUrl: returnVideo ? `${publicBaseUrl}/api/artifacts/${returnVideo.id}/download` : undefined,
					implementationDemoUrl: implementationDemo ? `${publicBaseUrl}/api/artifacts/${implementationDemo.id}/download` : undefined,
					draftPrUrl: run.draftPrUrl ?? undefined,
					previewUrl: run.previewUrl ?? undefined,
				},
			};
		} finally {
			client.release();
		}
	}
}

export function createPool(connectionString: string): Pool {
	return new Pool({ connectionString });
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}
