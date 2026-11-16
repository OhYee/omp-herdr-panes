import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { recordOf } from "./render.ts";

/** Session paths are explicit local read-only CLI input; IDs are never used as path components. */
export async function resolveSessionFile(reference: string, sessionDir?: string): Promise<string> {
	// @sec-exempt: path-traversal - an explicitly supplied local path is the requested read-only target.
	if (isAbsolute(reference) || reference.includes("/") || reference.includes("\\") || reference.endsWith(".jsonl")) return reference;
	if (!/^[0-9a-f-]+$/iu.test(reference)) throw new Error(`Invalid session ID: ${reference}`);
	const prefix = reference.toLowerCase();
	const roots = sessionDir ? [sessionDir] : sessionRoots(process.env);
	const matches: Array<{ id: string; path: string }> = [];
	const pending: Array<Promise<void>> = [];
	for (const root of roots) {
		if (!existsSync(root)) continue;
		const glob = new Bun.Glob("**/*.jsonl");
		for await (const path of glob.scan({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })) {
			pending.push((async () => {
				const id = await readSessionId(path);
				if (id?.toLowerCase().startsWith(prefix)) matches.push({ id, path });
			})());
			if (pending.length >= 32) await Promise.all(pending.splice(0));
		}
	}
	await Promise.all(pending);
	const exact = matches.filter(match => match.id.toLowerCase() === prefix);
	const candidates = exact.length ? exact : matches;
	if (candidates.length === 1) return candidates[0]!.path;
	if (!candidates.length) throw new Error(`Session ID "${reference}" not found (searched ${roots.join(", ")})`);
	throw new Error(`Session ID "${reference}" is ambiguous:\n${candidates.map(match => `  ${match.id}  ${match.path}`).sort().join("\n")}`);
}

function sessionRoots(env: Record<string, string | undefined>): string[] {
	const configRoot = env["PI_CONFIG_DIR"] || join(homedir(), ".omp");
	const profile = (env["OMP_PROFILE"] ?? env["PI_PROFILE"] ?? "").trim();
	if (profile && profile !== "default" && !/^[a-z0-9_-]+$/iu.test(profile)) throw new Error("Invalid OMP profile");
	const named = profile && profile !== "default";
	const configBase = named ? join(configRoot, "profiles", profile) : (env["PI_CODING_AGENT_DIR"] || join(configRoot, "agent"));
	const roots = [join(configBase, named ? "agent/sessions" : "sessions")];
	if (env["XDG_DATA_HOME"]) {
		const xdg = named ? join(env["XDG_DATA_HOME"], "omp", "profiles", profile) : join(env["XDG_DATA_HOME"], "omp");
		if (existsSync(xdg)) roots.unshift(join(xdg, "agent", "sessions"), join(xdg, "sessions"));
	}
	return [...new Set(roots)];
}

async function readSessionId(path: string): Promise<string | undefined> {
	try {
		const start = await Bun.file(path).slice(0, 128 * 1024).text();
		for (const line of start.split("\n")) {
			try {
				const entry = recordOf(JSON.parse(line));
				if (entry?.["type"] === "session" && typeof entry["id"] === "string") return entry["id"];
			} catch { /* An incomplete line is not a session header. */ }
		}
	} catch { /* A disappearing or unreadable file is not a match. */ }
	return undefined;
}
