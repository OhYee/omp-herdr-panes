import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSessionFile } from "../src/session-file.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "omp-viewer-sessions-"));
	const project = join(root, "project");
	const children = join(project, "parent");
	mkdirSync(children, { recursive: true });
	const parent = join(project, "2026-01-01_abc1-0000.jsonl");
	const child = join(children, "NamedAgent.jsonl");
	writeFileSync(parent, `${JSON.stringify({ type: "title", title: "example" })}\n${JSON.stringify({ type: "session", id: "abc1-0000" })}\n`);
	writeFileSync(child, `${JSON.stringify({ type: "session", id: "abc2-1234" })}\n`);
	return { root, parent, child };
}

test("resolves case-insensitive IDs and prefixes, including nested agent sessions", async () => {
	const { root, parent, child } = fixture();
	try {
		expect(await resolveSessionFile("ABC1", root)).toBe(parent);
		expect(await resolveSessionFile("abc2-1234", root)).toBe(child);
		expect(await resolveSessionFile(parent, root)).toBe(parent);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("reports ambiguous and missing IDs instead of picking an arbitrary session", async () => {
	const { root } = fixture();
	try {
		await expect(resolveSessionFile("abc", root)).rejects.toThrow("ambiguous");
		await expect(resolveSessionFile("def", root)).rejects.toThrow("not found");
		await expect(resolveSessionFile("invalid-id!", root)).rejects.toThrow("Invalid session ID");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
