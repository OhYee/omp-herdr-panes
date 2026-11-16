import { sanitize } from "./render.ts";
import { cardSummary, TranscriptModel, type CardKind } from "./tui-model.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clip(value: string, width: number): string {
	if (width <= 0) return "";
	let text = "";
	let columns = 0;
	for (const { segment } of segmenter.segment(value)) {
		const size = Bun.stringWidth(segment);
		if (columns + size > width) break;
		text += segment;
		columns += size;
	}
	return text;
}

function ellipsize(value: string, width: number): string {
	if (width <= 0) return "";
	if (Bun.stringWidth(value) <= width) return value;
	return `${clip(value, width - 1)}…`;
}

function ellipsizeStart(value: string, width: number): string {
	if (width <= 0) return "";
	if (Bun.stringWidth(value) <= width) return value;
	const segments = Array.from(segmenter.segment(value), item => item.segment);
	let suffix = "";
	let remaining = width - 1;
	for (let index = segments.length - 1; index >= 0; index--) {
		const segment = segments[index]!;
		const size = Bun.stringWidth(segment);
		if (size > remaining) break;
		suffix = segment + suffix;
		remaining -= size;
	}
	return `…${suffix}`;
}

function ellipsizeModel(value: string, width: number): string {
	if (Bun.stringWidth(value) <= width) return value;
	const colon = value.lastIndexOf(":");
	const suffix = colon > value.lastIndexOf("/") ? value.slice(colon) : "";
	if (!suffix || Bun.stringWidth(suffix) + 1 >= width) return ellipsize(value, width);
	return `${clip(value, width - Bun.stringWidth(suffix) - 1)}…${suffix}`;
}

function header(status: string, stream: string, label: string, model: string, follow: boolean, width: number): string {
	const statusColor = status === "failed" || status === "aborted" || status === "error" ? "31"
		: status === "running" || status === "completed" ? "32" : "33";
	const streamColor = stream === "unavailable" ? "31" : stream === "connecting" ? "33" : "36";
	const color = (text: string, code: string) => `\x1b[1;${code}m${text}\x1b[0m`;
	const prefix = `${status} · ${stream}`;
	const full = `${prefix} · ${label} · ${model}`;
	const render = (shownLabel: string, shownModel: string, showFollow = false) =>
		`${color(status, statusColor)} · ${color(stream, streamColor)} · ${color(shownLabel, "35")} · ${color(shownModel, "33")}${showFollow ? ` · ${color("follow", "36")}` : ""}`;
	if (follow && Bun.stringWidth(`${full} · follow`) <= width) return render(label, model, true);
	if (Bun.stringWidth(full) <= width) return render(label, model);
	const remaining = width - Bun.stringWidth(prefix) - 6;
	if (remaining < 2) return color(ellipsize(`${prefix} · ${model}`, width), statusColor);
	const minLabel = Math.min(Bun.stringWidth(label), 4, remaining - 1);
	const slash = model.indexOf("/");
	const shortModel = Bun.stringWidth(model) > remaining - minLabel && slash >= 0 ? `…/${model.slice(slash + 1)}` : model;
	const labelWidth = Math.min(Bun.stringWidth(label), Math.max(minLabel, remaining - Bun.stringWidth(shortModel)));
	return render(ellipsize(label, labelWidth), ellipsizeModel(shortModel, remaining - labelWidth));
}

interface WrappedLine { text: string; code: boolean }

function wrap(value: string, width: number, codeByDefault = false): WrappedLine[] {
	const out: WrappedLine[] = [];
	let fence: string | undefined;
	for (const line of sanitize(value).replace(/\r\n?/gu, "\n").split("\n")) {
		const marker = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
		let isFence = false;
		if (marker && !fence) { fence = marker[1]![0]; isFence = true; }
		else if (marker && fence === marker[1]![0] && marker[2]!.trim() === "") { fence = undefined; isFence = true; }
		const code = !isFence && (codeByDefault || fence !== undefined);
		if (!line) { out.push({ text: "", code }); continue; }
		let remaining = line;
		while (remaining) {
			const part = clip(remaining, width);
			if (!part) break;
			out.push({ text: part, code });
			remaining = remaining.slice(part.length);
		}
	}
	return out;
}

/** Lightweight highlighting for fenced code and structured tool arguments. Input is already sanitized. */
function highlightCode(text: string, base: string): string {
	const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|#.*|\b(?:async|await|break|case|class|const|continue|def|else|enum|export|false|fn|for|from|func|function|go|if|import|in|interface|let|match|nil|null|package|pass|pub|return|struct|switch|true|type|undefined|var|while)\b|\b\d+(?:\.\d+)?\b)/gu;
	return text.replace(tokens, (token: string) => {
		const color = token.startsWith("//") || token.startsWith("#") ? "90"
			: token.startsWith("\"") || token.startsWith("'") ? "32"
			: /^\d/u.test(token) ? "36" : "35";
		return `\x1b[${color}m${token}\x1b[0;${base}m`;
	});
}

interface Row { text: string; card: number; kind: CardKind; header: boolean; code?: boolean }

const CARD_COLORS: Record<CardKind, string> = {
	input: "35", thinking: "39", tools: "34", tool: "34", execution: "33", result: "36", advisor: "95", output: "32", status: "33",
};

/** An interactive, read-only transcript pane with per-item folding. */
export class ViewerTui {
	private top = 0;
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private selectedByUser = false;
	private stopped = false;
	private inputBuffer = "";
	private awaitingG = false;
	private notice = "";
	private readonly onInput = (chunk: Buffer | string) => {
		this.inputBuffer += String(chunk);
		const sequences = ["\u001b[A", "\u001b[B", "\u001b[5~", "\u001b[6~", "\u001b[H", "\u001b[F"];
		while (this.inputBuffer) {
			if (this.inputBuffer.startsWith("\u001b")) {
				const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/u.exec(this.inputBuffer);
				if (mouse) {
					this.mouse(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4] === "M");
					this.inputBuffer = this.inputBuffer.slice(mouse[0].length);
					continue;
				}
				if (("\u001b[<".startsWith(this.inputBuffer) || /^\u001b\[<[\d;]*$/u.test(this.inputBuffer)) && this.inputBuffer.length < 64) break;
				const sequence = sequences.find(candidate => this.inputBuffer.startsWith(candidate));
				if (sequence) { this.input(sequence); this.inputBuffer = this.inputBuffer.slice(sequence.length); continue; }
				if (sequences.some(candidate => candidate.startsWith(this.inputBuffer))) break;
			}
			this.input(this.inputBuffer[0]!);
			this.inputBuffer = this.inputBuffer.slice(1);
		}
	};
	private readonly onResize = () => this.requestRender();

	constructor(readonly model: TranscriptModel, private readonly title: string, private readonly sessionFile: string, private readonly quit: () => void) {}

	start(): void {
		process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", this.onInput);
		process.stdout.on("resize", this.onResize);
		this.render();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		clearTimeout(this.renderTimer);
		process.stdin.off("data", this.onInput);
		process.stdout.off("resize", this.onResize);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
		process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
	}

	requestRender(): void {
		if (this.stopped || this.renderTimer) return;
		this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.render(); }, 80);
	}

	private dimensions(): { width: number; height: number; available: number } {
		const width = Math.max(1, process.stdout.columns || 80);
		const height = Math.max(1, process.stdout.rows || 24);
		return { width, height, available: Math.max(0, height - 2) };
	}

	private rows(width: number): Row[] {
		const rows: Row[] = [];
		let inTools = false;
		for (const [index, card] of this.model.all.entries()) {
			if (card.kind === "tools") inTools = card.expanded;
			else if (card.kind !== "tool" && card.kind !== "result") inTools = false;
			const indent = inTools && width > 8 && (card.kind === "tool" || card.kind === "result") ? "  " : "";
			const marker = card.expanded ? "▾" : "▸";
			const preview = !card.expanded ? cardSummary(card.body.split(/\r?\n/u, 1)[0] ?? "") : "";
			const outcome = card.result ? (card.result.error ? " · error" : " · ok") : "";
			const label = `${indent}${index === this.model.selected ? ">" : " "} ${marker} ${cardSummary(card.title)}${outcome}${card.live ? " · live" : ""}`;
			rows.push({ text: clip(preview ? `${label}  ${preview}` : label, width), card: index, kind: card.kind, header: true });
			if (!card.expanded) continue;
			if (card.kind === "tool" && (card.result || card.execution?.length)) {
				const prefix = " ".repeat(Math.min(indent.length + 6, Math.max(0, width - 2)));
				rows.push({ text: clip(`${prefix}REQUEST`, width), card: index, kind: "tool", header: false });
				for (const line of wrap(card.body, Math.max(1, width - prefix.length), true)) {
					rows.push({ text: clip(`${prefix}${line.text}`, width), card: index, kind: "tool", header: false, code: line.code });
				}
				for (const execution of card.execution ?? []) {
					rows.push({ text: clip(`${prefix}${execution.title}`, width), card: index, kind: "execution", header: false });
					for (const line of wrap(execution.body, Math.max(1, width - prefix.length), true)) {
						rows.push({ text: clip(`${prefix}${line.text}`, width), card: index, kind: "execution", header: false, code: line.code });
					}
				}
				if (card.result) {
					rows.push({ text: clip(`${prefix}${card.result.error ? "ERROR" : "RESULT"}`, width), card: index, kind: "result", header: false });
					for (const line of wrap(card.result.body, Math.max(1, width - prefix.length))) {
						rows.push({ text: clip(`${prefix}${line.text}`, width), card: index, kind: "result", header: false, code: line.code });
					}
				}
				continue;
			}
			if (!card.body) continue;
			const prefix = " ".repeat(Math.min(indent.length + 4, Math.max(0, width - 2)));
			for (const line of wrap(card.body, Math.max(1, width - prefix.length), card.kind === "tool")) {
				rows.push({ text: clip(`${prefix}${line.text}`, width), card: index, kind: card.kind, header: false, code: line.code });
			}
		}
		return rows;
	}

	private mouse(button: number, _column: number, row: number, pressed: boolean): void {
		if (!pressed) return;
		if ((button & 64) !== 0) {
			this.model.follow = false;
			this.top = Math.max(0, this.top + ((button & 1) ? 3 : -3));
			this.requestRender();
			return;
		}
		const { width, height } = this.dimensions();
		if ((button & 3) !== 0 || row < 2 || row >= height) return;
		const visible = this.rows(width)[this.top + row - 2];
		if (!visible) return;
		this.model.follow = false;
		this.model.selected = visible.card;
		if (visible.header) this.model.toggle();
		this.selectedByUser = true;
		this.requestRender();
	}

	private scrollWithSelection(delta: number, height: number): void {
		const display = this.rows(Math.max(1, process.stdout.columns || 80));
		const maxTop = Math.max(0, display.length - height);
		const previousTop = Math.min(this.top, maxTop);
		const selectedRow = display.findIndex(row => row.header && row.card === this.model.selected);
		const offset = Math.max(0, Math.min(height - 1, selectedRow - previousTop));
		this.top = Math.max(0, Math.min(maxTop, previousTop + delta));
		const target = this.top + offset;
		let nearest: Row | undefined;
		let distance = Number.POSITIVE_INFINITY;
		for (let index = this.top; index < Math.min(display.length, this.top + height); index++) {
			const row = display[index];
			if (!row?.header || Math.abs(index - target) >= distance) continue;
			nearest = row;
			distance = Math.abs(index - target);
		}
		nearest ??= display[this.top];
		if (nearest) this.model.selected = nearest.card;
		this.model.follow = false;
		this.selectedByUser = false;
	}

	private input(data: string): void {
		if (data === "\u0003") { this.stop(); this.quit(); return; }
		this.notice = "";
		const rows = Math.max(1, this.dimensions().available);
		if (data === "g") {
			if (!this.awaitingG) { this.awaitingG = true; return; }
			this.awaitingG = false;
			this.model.follow = false;
			this.model.selected = 0;
			this.top = 0;
			this.requestRender();
			return;
		}
		this.awaitingG = false;
		if (data === "\u001b[A" || data === "k") { this.model.move(-1); this.selectedByUser = true; }
		else if (data === "\u001b[B" || data === "j") { this.model.move(1); this.selectedByUser = true; }
		else if (data === "\r" || data === "\n" || data === " ") { this.model.toggle(); this.selectedByUser = true; }
		else if (data === "h" || data === "l") {
			const card = this.model.all[this.model.selected];
			if (card) card.expanded = data === "l";
			this.selectedByUser = true;
		}
		else if (data === "a") this.model.toggleAll();
		else if (data === "t") { this.model.toggleThinking(); this.selectedByUser = true; }
		else if (data === "T") { this.model.toggleTools(); this.selectedByUser = true; }
		else if (data === "p") {
			process.stdout.write(`\x1b]52;c;${Buffer.from(this.sessionFile, "utf8").toString("base64")}\x07`);
			this.notice = "Clipboard copy requested";
		}
		else if (data === "f" || data === "G" || data === "\u001b[F") { this.model.follow = true; this.model.selected = Math.max(0, this.model.all.length - 1); }
		else if (data === "\u0015" || data === "\u0004") this.scrollWithSelection((data === "\u0015" ? -1 : 1) * Math.max(1, Math.floor(rows / 2)), rows);
		else if (data === "\u001b[5~") { this.model.follow = false; this.top = Math.max(0, this.top - rows); }
		else if (data === "\u001b[6~") { this.model.follow = false; this.top += rows; }
		else if (data === "\u001b[H") { this.model.follow = false; this.top = 0; }
		else return;
		this.requestRender();
	}

	private render(): void {
		if (this.stopped) return;
		const { width, height, available } = this.dimensions();
		const rows = this.rows(width);
		const maxTop = Math.max(0, rows.length - available);
		if (this.model.follow) this.top = maxTop;
		else if (this.selectedByUser) {
			const selectedRow = rows.findIndex(row => row.card === this.model.selected && row.header);
			if (selectedRow >= 0 && selectedRow < this.top) this.top = selectedRow;
			else if (selectedRow >= this.top + available) this.top = selectedRow - available + 1;
		}
		this.selectedByUser = false;
		this.top = Math.max(0, Math.min(this.top, maxTop));
		const label = cardSummary(this.title) || "Subagent";
		const stream = this.model.streamStatus ?? "file";
		const status = header(cardSummary(this.model.status), stream, label, cardSummary(this.model.model) || "unknown", this.model.follow, width);
		const space = width - Bun.stringWidth(Bun.stripANSI(status)) - 3;
		const path = sanitize(this.sessionFile).replace(/\r?\n/gu, " ");
		const title = space > 1 ? `${status} · ${ellipsizeStart(path, space)}` : status;
		const hint = this.notice || "p copy path  T tools  t THINK  Ctrl+C exit  a all  j/k select  h/l fold  ^U/^D scroll  gg/G";
		const screen: string[] = [title];
		if (rows.length === 0 && available > 0) screen.push(clip("Waiting for transcript…", width));
		for (const row of rows.slice(this.top, this.top + available)) {
			const selected = row.header && row.card === this.model.selected;
			const color = CARD_COLORS[row.kind];
			const style = `\x1b[${selected ? "7;" : ""}${color}m`;
			const text = row.code ? highlightCode(row.text, color) : row.text;
			screen.push(`${style}${text}\x1b[0m`);
		}
		while (screen.length < height - 1) screen.push("");
		if (height > 1) screen.push(`\x1b[33m${clip(hint, width)}\x1b[0m`);
		process.stdout.write(`\x1b[H${screen.slice(0, height).map(line => `\x1b[2K${line}`).join("\r\n")}`);
	}
}
