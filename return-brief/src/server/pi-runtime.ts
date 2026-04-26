import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, type AgentSession, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import returnBriefExtension from "../../index.js";
import { SERVER_PROMPT_PATHS } from "./prompts.js";

export interface PiSessionHandle {
	session: AgentSession;
	dispose(): void;
}

const READ_ONLY_BUILTINS = ["read", "bash", "grep", "find", "ls"] as const;
const MUTATION_BUILTINS = [...READ_ONLY_BUILTINS, "edit", "write"] as const;
const AUDIT_TOOLS = [
	"get_runtime_config",
	"validate_app_target",
	"list_open_prs",
	"list_open_issues",
	"get_pr_details",
	"get_recent_workflow_runs",
	"get_latest_release",
	"score_release_risk",
	"inspect_repo_for_suggestions",
	"map_pr_to_ui_routes",
	"write_structured_report",
	"build_scene_graph",
	"render_scenes_html",
	"narrate_scenes",
	"record_scene_videos",
	"compose_return_video",
	"save_feedback",
	"launch_followup_run",
] as const;
const IMPLEMENTATION_TOOLS = [
	"get_runtime_config",
	"validate_app_target",
	"write_implementation_plan",
	"checkout_branch",
	"record_implementation_baseline",
	"record_implementation_after",
	"compose_implementation_demo",
	"create_draft_issue_pr",
	"wait_for_pr_deployment_url",
	"save_feedback",
	"launch_followup_run",
] as const;

function resolveActiveTools(allowWrite: boolean): string[] {
	return allowWrite
		? [...MUTATION_BUILTINS, ...IMPLEMENTATION_TOOLS]
		: [...READ_ONLY_BUILTINS, ...AUDIT_TOOLS];
}

function applyRuntimeApiKeys(storage: AuthStorage): void {
	const mappings: Array<[provider: string, envName: string]> = [
		["anthropic", "ANTHROPIC_API_KEY"],
		["openai", "OPENAI_API_KEY"],
		["google", "GOOGLE_API_KEY"],
	];
	for (const [provider, envName] of mappings) {
		const value = process.env[envName];
		if (value) storage.setRuntimeApiKey(provider, value);
	}
}

function resolveModel(registry: ModelRegistry) {
	const configured = process.env.PI_MODEL;
	if (configured) {
		const [provider, ...rest] = configured.split("/");
		const modelId = rest.join("/");
		const model = registry.find(provider, modelId);
		if (!model) throw new Error(`PI_MODEL ${configured} not found in the Pi model registry`);
		return model;
	}
	const available = registry.getAvailable();
	if (available.length === 0) {
		throw new Error("No Pi models are available. Configure a provider API key in the environment.");
	}
	return available[0];
}

export async function createServerPiSession(opts: {
	cwd: string;
	agentDir: string;
	allowWrite: boolean;
	onEvent?: (event: AgentSessionEvent) => void;
}): Promise<PiSessionHandle> {
	const authStorage = AuthStorage.inMemory();
	applyRuntimeApiKeys(authStorage);
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const model = resolveModel(modelRegistry);
	const resourceLoader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		extensionFactories: [returnBriefExtension],
		additionalPromptTemplatePaths: SERVER_PROMPT_PATHS,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: [
			"You are Return Brief running inside a server-hosted Pi session.",
			"Operate only within the checked out workspace.",
			"Prefer the registered tools for GitHub/report/video workflows over ad hoc shell commands when they exist.",
		].join(" "),
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		model,
		authStorage,
		modelRegistry,
		resourceLoader,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
		}),
		sessionManager: SessionManager.inMemory(opts.cwd),
		thinkingLevel: (process.env.PI_THINKING_LEVEL as "off" | "low" | "medium" | "high" | undefined) ?? "medium",
	});
	session.setActiveToolsByName(resolveActiveTools(opts.allowWrite));

	const unsubscribe = opts.onEvent ? session.subscribe(opts.onEvent) : undefined;
	return {
		session,
		dispose() {
			unsubscribe?.();
			session.dispose();
		},
	};
}

export function summarizeSessionEvent(event: AgentSessionEvent): { type: string; payload: Record<string, unknown> } | null {
	switch (event.type) {
		case "turn_start":
			return { type: "turn_start", payload: {} };
		case "turn_end":
			return { type: "turn_end", payload: {} };
		case "tool_execution_start":
			return { type: "tool_call", payload: { toolName: event.toolName, input: event.args, toolCallId: event.toolCallId } };
		case "tool_execution_update":
			return { type: "tool_update", payload: { toolName: event.toolName, partialResult: event.partialResult, toolCallId: event.toolCallId } };
		case "tool_execution_end":
			return {
				type: "tool_result",
				payload: { toolName: event.toolName, isError: event.isError, toolCallId: event.toolCallId, result: event.result },
			};
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				return { type: "assistant_delta", payload: { delta: event.assistantMessageEvent.delta } };
			}
			return null;
		case "auto_retry_start":
			return { type: "auto_retry_start", payload: { attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage } };
		case "auto_retry_end":
			return { type: "auto_retry_end", payload: { success: event.success, attempt: event.attempt, finalError: event.finalError } };
		default:
			return null;
	}
}
