/**
 * Transcript renderer for subagent entries.
 *
 * No I/O: it maps one parsed JSONL entry to display lines and can index IRC calls for receipts.
 * Unknown entries fall back to their JSON representation. `renderEntry` never throws.
 */

export interface RenderOptions {
	/** Terminal columns. Every returned line must fit (visible width <= width). */
	width: number;
	/** Emit ANSI styling. When false, output must contain no escape sequences. */
	color: boolean;
	/** How many trailing non-empty lines of each thinking block to show; 0 hides thinking. */
	thinkingLines: number;
	/** Session totals accumulated by the viewer; shown on `session_exit` when supplied. */
	totals?: SessionTotals;
	/** Calls seen by a streaming text viewer, for associating IRC receipts with their recipients. */
	ircCalls?: Map<string, IrcOutput | null>;
}

/** Token/cost/duration totals accumulated across one transcript session. */
export interface SessionTotals {
	tokens: number;
	cost: number;
	durationMs: number | null;
}

interface IrcOutput {
	label: string;
	content: string;
}

type Style = "bold" | "red" | "green" | "cyan";

interface Segment {
	text: string;
	style: Style | null;
}

const STYLE_CODES: Record<Style, string> = {
	bold: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	cyan: "\x1b[36m",
};

const RESET = "\x1b[0m";
const ELLIPSIS = "…";
const MIN_WIDTH = 10;
const USER_TEXT_MARKER = "Complete assignment thoroughly:";
const USER_TEXT_LINE_LIMIT = 6;
const SUMMARY_KEYS = ["command", "path", "pattern", "query", "url", "task", "code"] as const;

/** Turn one parsed JSONL entry into display lines, falling back to JSON. Never throws. */
export function renderEntry(entry: unknown, options: RenderOptions): string[] {
	try {
		if (options.ircCalls) indexIrcCalls(entry, options.ircCalls);
		const record = recordOf(entry);
		const type = record?.["type"];
		const rendered = record === null ? [] :
			type === "session_init" ? renderSessionInit(record, options) :
			type === "message" ? renderMessage(record, options) :
			type === "custom_message" && (record["customType"] === "irc:incoming" || record["customType"] === "async-result" || record["customType"] === "advisor") ? renderCustomMessage(record, options) :
			type === "custom" ? renderCustom(record, options) : [];
		const message = recordOf(record?.["message"]);
		const content = message?.["content"];
		if (!rendered.length && options.thinkingLines === 0 && message?.["role"] === "assistant" &&
			Array.isArray(content) && content.length > 0 &&
			content.every(block => recordOf(block)?.["type"] === "thinking" && typeof recordOf(block)?.["thinking"] === "string")) return [];
		return rendered.length ? rendered : renderFallback(entry, options);
	} catch {
		return [];
	}
}

function renderFallback(value: unknown, options: RenderOptions): string[] {
	const json = JSON.stringify(value, null, 2) ?? String(value);
	const width = normalizeWidth(options.width);
	const lines: string[] = [];
	for (const line of sanitize(json).split("\n")) {
		let rest = line;
		while (Bun.stringWidth(rest) > width) {
			const part = sliceVisible(rest, width);
			if (!part) break;
			lines.push(part);
			rest = rest.slice(part.length);
		}
		lines.push(rest);
	}
	return lines;
}

/** Human-readable summary of a tool call's arguments. */
export function summarizeArgs(args: unknown): string {
	const record = recordOf(args);
	if (record !== null) {
		for (const key of SUMMARY_KEYS) {
			const value = record[key];
			if (typeof value === "string") {
				const collapsed = collapseWhitespace(value);
				if (collapsed.length > 0) return collapsed;
			}
		}
	}
	return stringifyCollapsed(args);
}

/** Identify a complete agent message without treating ordinary writes as IRC. */
export function ircOutput(name: unknown, args: unknown): IrcOutput | null {
	const record = recordOf(args);
	if (name !== "write" || typeof record?.["path"] !== "string" || typeof record["content"] !== "string") return null;
	const match = /^agent:\/\/([^\s/?#]+)(?:\?([^#]*))?$/u.exec(record["path"]);
	if (!match) return null;
	const recipient = match[1] === "all" ? "all (broadcast)" : match[1]!;
	const progress = new URLSearchParams(match[2] ?? "").has("progress") ? " progress" : "";
	return { label: `IRC${progress} → ${recipient}`, content: record["content"] };
}

function indexIrcCalls(entry: unknown, calls: Map<string, IrcOutput | null>): void {
	const record = recordOf(entry);
	const message = record?.["type"] === "message" ? recordOf(record["message"]) : null;
	if (message?.["role"] !== "assistant" || !Array.isArray(message["content"])) return;
	for (const raw of message["content"]) {
		const block = recordOf(raw);
		const id = block?.["id"];
		if (block?.["type"] !== "toolCall" || typeof id !== "string" || !id) continue;
		calls.set(id, calls.has(id) ? null : ircOutput(block["name"], block["arguments"]));
	}
}

/**
 * Token and cost totals of one assistant message entry. Non-assistant entries, and entries
 * without a numeric usage, yield `null`/zeros; the result feeds the `session_exit` totals line.
 */
export function usageOf(entry: unknown): { tokens: number; cost: number } | null {
	const record = recordOf(entry);
	if (record === null || record["type"] !== "message") return null;
	const message = recordOf(record["message"]);
	if (message === null || message["role"] !== "assistant") return null;
	const usage = recordOf(message["usage"]);
	if (usage === null) return { tokens: 0, cost: 0 };
	const cost = recordOf(usage["cost"]);
	const totalTokens = usage["totalTokens"];
	const totalCost = cost === null ? undefined : cost["total"];
	return {
		tokens: typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : 0,
		cost: typeof totalCost === "number" && Number.isFinite(totalCost) ? totalCost : 0,
	};
}

/**
 * Remove everything a transcript could smuggle into the terminal: ANSI escape sequences
 * (CSI/OSC, `Bun.stripANSI`), then any remaining C0 control except `\n` (tab becomes one space),
 * plus DEL and the C1 range. Styling is applied after sanitizing, so `STYLE_CODES` survive.
 */
export function sanitize(text: string): string {
	return Bun.stripANSI(text)
		.replace(/\t/gu, " ")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
}

// -- entry renderers ---------------------------------------------------------

function renderSessionInit(record: Record<string, unknown>, options: RenderOptions): string[] {
	const agent = stringProp(record, "agent");
	if (agent === null || agent.length === 0) return [];
	const model = stringProp(record, "resolvedModel");
	const text = model === null || model.length === 0 ? `● ${agent}` : `● ${agent} · ${model}`;
	return [composeLine([{ text, style: "bold" }], options, true)];
}

function renderMessage(record: Record<string, unknown>, options: RenderOptions): string[] {
	const message = recordOf(record["message"]);
	if (message === null) return [];
	const role = message["role"];
	if (role === "user") return renderUserMessage(message, options);
	if (role === "assistant") return renderAssistantMessage(message, options);
	if (role === "toolResult") return renderToolResultMessage(message, options);
	return [];
}

function renderCustomMessage(record: Record<string, unknown>, options: RenderOptions): string[] {
	const content = record["content"];
	if (typeof content !== "string" && !Array.isArray(content)) return [];
	const title = record["customType"] === "irc:incoming" ? "IRC input:" : record["customType"] === "advisor" ? "Advisor:" : "Async result:";
	const out = [composeLine([{ text: title, style: "bold" }], options, true)];
	if (typeof content === "string") out.push(...wrapText(content, normalizeWidth(options.width)));
	else for (const block of content) {
		const item = recordOf(block);
		if (item?.["type"] === "text" && typeof item["text"] === "string") out.push(...wrapText(item["text"], normalizeWidth(options.width)));
		else out.push(...renderFallback(block, options));
	}
	return out;
}

function renderUserMessage(message: Record<string, unknown>, options: RenderOptions): string[] {
	const content = message["content"];
	if (!Array.isArray(content) && typeof content !== "string") return [];
	const lines = nonEmptyLines(typeof content === "string" ? content : joinTextBlocks(content));
	if (lines[0] === USER_TEXT_MARKER) lines.shift();
	const out = [composeLine([{ text: "Task:", style: "bold" }], options, true)];
	for (const line of lines.slice(0, USER_TEXT_LINE_LIMIT)) {
		out.push(composeLine([{ text: `  ${line}`, style: null }], options, true));
	}
	if (Array.isArray(content)) out.push(...renderUnknownBlocks(content, options));
	return out;
}

function renderAssistantMessage(message: Record<string, unknown>, options: RenderOptions): string[] {
	const content = message["content"];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const block of content) {
		const record = recordOf(block);
		if (record === null) { out.push(...renderFallback(block, options)); continue; }
		const blockType = record["type"];
		if (blockType === "thinking" && typeof record["thinking"] === "string") out.push(...renderThinkingBlock(record, options));
		else if (blockType === "text" && typeof record["text"] === "string") out.push(...renderTextBlock(record, options));
		else if (blockType === "toolCall" && typeof record["name"] === "string") out.push(...renderToolCallBlock(record, options));
		else out.push(...renderFallback(block, options));
	}
	const stopReason = message["stopReason"];
	if (stopReason === "error") {
		const errorMessage = stringProp(message, "errorMessage");
		const collapsed = errorMessage === null ? "" : collapseWhitespace(errorMessage);
		out.push(composeLine([{ text: collapsed.length > 0 ? `✗ error: ${collapsed}` : "✗ error", style: "red" }], options, true));
	} else if (stopReason === "aborted") {
		out.push(composeLine([{ text: "✗ aborted", style: "red" }], options, true));
	}
	return out;
}

function renderThinkingBlock(record: Record<string, unknown>, options: RenderOptions): string[] {
	const shown = normalizeThinkingLines(options.thinkingLines);
	if (shown === 0) return [];
	const thinking = stringProp(record, "thinking");
	if (thinking === null) return [];
	return nonEmptyLines(thinking)
		.slice(-shown)
		.map((line) => composeLine([{ text: `  ~ ${line}`, style: null }], options, true));
}

function renderTextBlock(record: Record<string, unknown>, options: RenderOptions): string[] {
	const text = stringProp(record, "text");
	if (text === null) return [];
	return wrapText(text, normalizeWidth(options.width));
}

function renderToolCallBlock(record: Record<string, unknown>, options: RenderOptions): string[] {
	const name = stringProp(record, "name");
	if (name === null || name.length === 0) return [];
	const irc = ircOutput(name, record["arguments"]);
	if (irc) {
		const title = composeLine([{ text: `OUTPUT · ${irc.label}`, style: "bold" }], options, true);
		const lines: string[] = [];
		const width = normalizeWidth(options.width);
		for (const line of sanitize(irc.content).split("\n")) {
			let rest = line;
			while (Bun.stringWidth(rest) > width) {
				const part = sliceVisible(rest, width);
				if (!part) break;
				lines.push(part);
				rest = rest.slice(part.length);
			}
			lines.push(rest);
		}
		return [title, ...lines];
	}
	const intent = stringProp(record, "intent");
	const collapsedIntent = intent === null ? "" : collapseWhitespace(intent);
	let summary: string;
	if (collapsedIntent.length > 0) summary = collapsedIntent;
	else if (name === "yield") summary = yieldSummary(record["arguments"]);
	else summary = summarizeArgs(record["arguments"]);
	const segments: Segment[] = [
		{ text: "▸ ", style: null },
		{ text: name, style: "cyan" },
	];
	if (summary.length > 0) segments.push({ text: `  ${summary}`, style: null });
	return [composeLine(segments, options, true)];
}

/** One-liner for a `yield` call: its error, or `status` plus the remaining `data` keys. */
function yieldSummary(args: unknown): string {
	const record = recordOf(args);
	if (record === null) return summarizeArgs(args);
	const error = record["error"];
	if (typeof error === "string") {
		const collapsed = collapseWhitespace(error);
		return collapsed.length > 0 ? `error: ${collapsed}` : "error";
	}
	const data = recordOf(record["data"]);
	if (data === null) return summarizeArgs(args);
	const keys = Object.keys(data).filter((key) => key !== "status");
	const status = data["status"];
	if (typeof status === "string") {
		const head = `status: ${collapseWhitespace(status)}`;
		return keys.length > 0 ? `${head} · ${keys.join(", ")}` : head;
	}
	return keys.length > 0 ? keys.join(", ") : summarizeArgs(args);
}

function renderToolResultMessage(message: Record<string, unknown>, options: RenderOptions): string[] {
	const isError = message["isError"] === true;
	const content = message["content"];
	if (!Array.isArray(content) && typeof content !== "string") return [];
	const lines = nonEmptyLines(typeof content === "string" ? content : joinTextBlocks(content));
	const toolName = stringProp(message, "toolName");
	const callId = stringProp(message, "toolCallId");
	const irc = callId ? options.ircCalls?.get(callId) : undefined;
	const unknown = irc && typeof message["isError"] !== "boolean";
	const segments: Segment[] = [
		{ text: "  ", style: null },
		{ text: unknown ? "·" : isError ? "✗" : "✓", style: unknown ? null : isError ? "red" : "green" },
	];
	if (irc) segments.push({ text: ` ${irc.label} `, style: "cyan" });
	else if (toolName !== null && toolName.length > 0) segments.push({ text: ` ${toolName} `, style: "cyan" });
	const first = lines[0];
	if (first === undefined) {
		segments.push({ text: " (no output)", style: null });
	} else {
		segments.push({ text: ` ${first}`, style: null });
		const extra = lines.length - 1;
		if (extra > 0) segments.push({ text: ` (+${extra} lines)`, style: null });
	}
	return [composeLine(segments, options, true), ...(Array.isArray(content) ? renderUnknownBlocks(content, options) : [])];
}

function renderCustom(record: Record<string, unknown>, options: RenderOptions): string[] {
	if (record["customType"] === "tool_execution_start") {
		const data = recordOf(record["data"]);
		const id = typeof data?.["toolCallId"] === "string" ? data["toolCallId"] : "";
		const irc = id ? options.ircCalls?.get(id) : undefined;
		if (irc) {
			const args = recordOf(data?.["args"]);
			if (args?.["content"] === irc.content) {
				const { content: _content, ...rest } = args;
				return [composeLine([{ text: `${irc.label} · tool_execution_start`, style: "cyan" }], options, true),
					...renderFallback({ ...record, data: { ...data, args: rest } }, options)];
			}
			return [composeLine([{ text: `${irc.label} · tool_execution_start`, style: "cyan" }], options, true), ...renderFallback(record, options)];
		}
	}
	if (record["customType"] !== "session_exit") return [];
	const parts: string[] = [];
	const totals = options.totals;
	if (totals !== undefined) {
		if (totals.tokens > 0) parts.push(`${formatTokens(totals.tokens)} tok`);
		if (totals.cost !== 0) parts.push(`$${totals.cost.toFixed(4)}`);
		if (totals.durationMs !== null) parts.push(formatDuration(totals.durationMs));
	}
	const text = parts.length === 0 ? "■ session ended" : `■ session ended · ${parts.join(" · ")}`;
	return [composeLine([{ text, style: null }], options, true)];
}

/** `999`, `47.2k`, `1.2M`. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(Math.round(tokens));
}

/** `45s`, `2m13s`, `1h04m`. */
function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${seconds}s`;
}

// -- text helpers ------------------------------------------------------------

/** Narrow an external value to a plain record; the only cast of transcript data in this module. */
export function recordOf(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function stringProp(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

/** Collapse every run of whitespace (including newlines) into a single space. */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function stringifyCollapsed(value: unknown): string {
	try {
		const json: unknown = JSON.stringify(value);
		return typeof json === "string" ? collapseWhitespace(json) : "";
	} catch {
		return "";
	}
}

/** Text of every `text` content block, joined with newlines. */
function joinTextBlocks(content: unknown[]): string {
	const parts: string[] = [];
	for (const block of content) {
		const record = recordOf(block);
		if (record?.["type"] === "text" && typeof record["text"] === "string") parts.push(record["text"]);
	}
	return parts.join("\n");
}

function renderUnknownBlocks(content: unknown[], options: RenderOptions): string[] {
	const lines: string[] = [];
	for (const block of content) {
		const record = recordOf(block);
		if (record?.["type"] !== "text" || typeof record["text"] !== "string") lines.push(...renderFallback(block, options));
	}
	return lines;
}

function nonEmptyLines(text: string): string[] {
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line.length > 0) lines.push(line);
	}
	return lines;
}

// -- width handling ----------------------------------------------------------

function normalizeWidth(width: number): number {
	if (!Number.isFinite(width)) return MIN_WIDTH;
	const floored = Math.floor(width);
	return floored < MIN_WIDTH ? MIN_WIDTH : floored;
}

function normalizeThinkingLines(count: number): number {
	if (!Number.isFinite(count)) return 0;
	const floored = Math.floor(count);
	return floored < 0 ? 0 : floored;
}

/** Longest prefix of `text` that fits in `maxWidth` visible columns. */
function sliceVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	let result = "";
	let used = 0;
	for (const char of text) {
		const charWidth = Bun.stringWidth(char);
		if (used + charWidth > maxWidth) break;
		result += char;
		used += charWidth;
	}
	return result;
}

/**
 * Compose one display line from styled segments. Segment text is sanitized first, so no terminal
 * control sequence can reach the output; styling is added afterwards. Non-text lines that exceed
 * `width` are cut to `width - 1` visible columns plus an ellipsis on the plain text, before ANSI.
 */
function composeLine(segments: Segment[], options: RenderOptions, truncate: boolean): string {
	const clean = segments.map((segment) => ({ text: sanitize(segment.text), style: segment.style }));
	const width = normalizeWidth(options.width);
	let finalSegments = clean;
	if (truncate) {
		const plain = clean.map((segment) => segment.text).join("");
		if (Bun.stringWidth(plain) > width) finalSegments = truncateSegments(clean, width);
	}
	if (!options.color) return finalSegments.map((segment) => segment.text).join("");
	return finalSegments
		.map((segment) => (segment.style === null ? segment.text : STYLE_CODES[segment.style] + segment.text + RESET))
		.join("");
}

function truncateSegments(segments: Segment[], width: number): Segment[] {
	let remaining = width - Bun.stringWidth(ELLIPSIS);
	const out: Segment[] = [];
	for (const segment of segments) {
		const segmentWidth = Bun.stringWidth(segment.text);
		if (segmentWidth <= remaining) {
			out.push(segment);
			remaining -= segmentWidth;
			continue;
		}
		const head = sliceVisible(segment.text, remaining);
		if (head.length > 0) out.push({ text: head, style: segment.style });
		remaining = 0;
		break;
	}
	out.push({ text: ELLIPSIS, style: null });
	return out;
}

/** Word-wrap `text` to `width`, hard-breaking words longer than `width`; blank lines are kept. */
function wrapText(text: string, width: number): string[] {
	const normalized = sanitize(text).replace(/\r\n?/gu, "\n").replace(/\n+$/u, "");
	if (normalized.trim().length === 0) return [];
	const out: string[] = [];
	for (const raw of normalized.split("\n")) {
		const words = raw.split(/\s+/u).filter((word) => word.length > 0);
		if (words.length === 0) {
			out.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		for (const word of words) {
			let rest = word;
			while (Bun.stringWidth(rest) > width) {
				const head = sliceVisible(rest, width);
				if (head.length === 0) break;
				if (current.length > 0) {
					out.push(current);
					current = "";
					currentWidth = 0;
				}
				out.push(head);
				rest = rest.slice(head.length);
			}
			if (rest.length === 0) continue;
			const restWidth = Bun.stringWidth(rest);
			if (current.length === 0) {
				current = rest;
				currentWidth = restWidth;
			} else if (currentWidth + 1 + restWidth <= width) {
				current += ` ${rest}`;
				currentWidth += 1 + restWidth;
			} else {
				out.push(current);
				current = rest;
				currentWidth = restWidth;
			}
		}
		if (current.length > 0) out.push(current);
	}
	return out;
}
