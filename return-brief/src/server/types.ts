export type RunMode = "repo-overview" | "implement-change" | "revise-from-feedback";
export type InternalRunMode = RunMode | "preview-watch";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelling" | "cancelled";

export interface RepoTargetConfig {
	id: string;
	name: string;
	repo: string;
	cloneUrl: string;
	defaultBranch: string;
	installCommand?: string;
	buildCommand?: string;
	startCommand?: string;
	port: number;
	healthcheckPath?: string;
	testCommands?: string[];
	env?: Record<string, string>;
	envAllowlist?: string[];
	demo?: {
		routes?: string[];
		selectors?: Record<string, string>;
	};
}

export interface RunRequestInput {
	repoId: string;
	mode: RunMode;
	prompt?: string;
	issueNumber?: number;
	task?: string;
}

export interface RunRecord {
	id: string;
	repoId: string;
	mode: InternalRunMode;
	status: RunStatus;
	input: Record<string, unknown>;
	branch: string | null;
	draftPrUrl: string | null;
	previewUrl: string | null;
	errorMessage: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	cancelRequestedAt: string | null;
}

export interface RunEventRecord {
	id: number;
	runId: string;
	type: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export type ArtifactKind =
	| "report_json"
	| "report_md"
	| "assistant_response"
	| "return_video"
	| "implementation_plan"
	| "implementation_demo"
	| "diagnostic_json"
	| "screenshot"
	| "questions_json";

export interface ArtifactRecord {
	id: string;
	runId: string;
	kind: ArtifactKind;
	storageKey: string;
	mimeType: string;
	sizeBytes: number;
	checksum: string | null;
	createdAt: string;
}

export interface ArtifactLinkSet {
	reportUrl?: string;
	assistantResponseUrl?: string;
	returnBriefVideoUrl?: string;
	implementationDemoUrl?: string;
}

export interface ApiRunView extends RunRecord {
	repo: {
		id: string;
		name: string;
		repo: string;
		defaultBranch: string;
	};
	artifacts: ArtifactRecord[];
	links: ArtifactLinkSet & {
		draftPrUrl?: string;
		previewUrl?: string;
	};
}

export interface QueueRunJob {
	runId: string;
}
