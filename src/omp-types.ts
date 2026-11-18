/**
 * Minimal structural subset of omp's extension API (@oh-my-pi/pi-coding-agent 18.3.1).
 * Declared locally so the project does not depend on the full omp package.
 */
export interface OmpEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface OmpLogger {
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
}

export interface ExtensionAPI {
	events: OmpEventBus;
	logger: OmpLogger;
	registerCommand(name: string, options: {
		description: string;
		getArgumentCompletions?: (argumentPrefix: string) => Array<{ value: string; label: string; description?: string }> | null;
		handler: (args: string, ctx: { ui: { notify(message: string, type: "info" | "error"): void } }) => void | Promise<void>;
	}): void;
	on(
		event: "tool_approval_requested" | "tool_approval_resolved" | "plan_review_requested" | "plan_review_resolved",
		handler: (event: unknown, ctx: { sessionManager: { getSessionFile(): string | undefined } }) => void,
	): void;
	on(
		event: "session_start" | "session_switch" | "before_agent_start" | "agent_start",
		handler: (event: unknown, ctx: { sessionManager: { getSessionFile(): string | undefined } }) => void,
	): void;
	on(
		event: "session_shutdown",
		handler: (event: unknown, ctx: unknown) => void | Promise<void>,
	): void;
}
