import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	buildContextDocument,
	buildHerdrArgs,
	buildNativeBridgeMessage,
	buildParentContextMessage,
	classifyLaunchResult,
	createPayload,
	isBtwPayload,
	safeErrorText,
} from "../src/core.ts";
import { fixturePayloadOptions } from "./fixtures.ts";

test("buildContextDocument preserves metadata and serialized conversation", () => {
	const document = buildContextDocument(
		{
			generatedAt: "2026-07-15T00:00:00.000Z",
			cwd: "/tmp/project with spaces",
			session: "/tmp/session.jsonl",
			model: "provider/model",
		},
		"User: hello\nAssistant: hi",
	);

	assert.match(document, /Parent cwd: \/tmp\/project with spaces/);
	assert.match(document, /Parent model: provider\/model/);
	assert.match(document, /<parent-conversation>\nUser: hello\nAssistant: hi\n<\/parent-conversation>/);
});

test("buildParentContextMessage creates one reference user message", () => {
	const message = buildParentContextMessage("# Snapshot");
	assert.equal(message.role, "user");
	assert.equal(message.timestamp, 0);
	assert.deepEqual(message.content, [
		{
			type: "text",
			text: "The following Markdown document is a read-only snapshot of the parent session. Use it as reference context for this side conversation.\n\n# Snapshot",
		},
	]);
});

test("buildHerdrArgs targets the current workspace and tab with a payload path only", () => {
	const args = buildHerdrArgs({
		paneName: "btw-abc123",
		cwd: "/tmp/project with spaces",
		workspaceId: "w1",
		tabId: "w1:t2",
		payloadPath: "/tmp/pi-herdr-btw-1000/launch-abc/payload.json",
		model: "provider/model",
		thinkingLevel: "high",
		toolMode: "read-only",
		activeTools: ["read", "bash"],
		split: "right",
	});

	assert.deepEqual(args, [
		"agent",
		"start",
		"btw-abc123",
		"--cwd",
		"/tmp/project with spaces",
		"--workspace",
		"w1",
		"--tab",
		"w1:t2",
		"--split",
		"right",
		"--env",
		"PI_HERDR_BTW_PAYLOAD=/tmp/pi-herdr-btw-1000/launch-abc/payload.json",
		"--focus",
		"--",
		"pi",
		"--no-session",
		"--model",
		"provider/model",
		"--thinking",
		"high",
		"--tools",
		"read,grep,find,ls",
	]);
	assert.equal(args.some((arg) => arg.includes("secret question")), false);
});

test("buildHerdrArgs omits unavailable workspace and tab identifiers", () => {
	const args = buildHerdrArgs({
		paneName: "btw-abc123",
		cwd: "/tmp/project",
		payloadPath: "/tmp/payload.json",
		model: "provider/model",
		thinkingLevel: "off",
		toolMode: "none",
		activeTools: [],
		split: "down",
	});
	assert.equal(args.includes("--workspace"), false);
	assert.equal(args.includes("--tab"), false);
	assert.deepEqual(args.slice(args.indexOf("--split"), args.indexOf("--split") + 2), ["--split", "down"]);
	assert.equal(args.at(-1), "--no-tools");
});

test("buildHerdrArgs appends the launch-draft sentinel as the child's initial message", () => {
	const options = {
		paneName: "btw-abc123",
		cwd: "/tmp/project",
		payloadPath: "/tmp/payload.json",
		model: "provider/model",
		thinkingLevel: "high",
		toolMode: "none" as const,
		activeTools: [],
		split: "right" as const,
	};
	// The sentinel must be the final positional argument, after every flag,
	// so pi treats it as the initial message processed after initial render.
	const args = buildHerdrArgs({ ...options, initialMessage: "/btw --launch-draft" });
	assert.equal(args.at(-1), "/btw --launch-draft");
	assert.equal(args.at(-2), "--no-tools");
	// Without an initial message nothing is appended.
	assert.equal(buildHerdrArgs(options).at(-1), "--no-tools");
});

test("buildHerdrArgs passes the exact parent tool set for inherit mode", () => {
	const options = {
		paneName: "btw-abc123",
		cwd: "/tmp/project",
		payloadPath: "/tmp/payload.json",
		model: "provider/model",
		thinkingLevel: "high",
		toolMode: "inherit" as const,
		activeTools: ["read", "bash", "edit"],
		split: "right" as const,
	};
	const args = buildHerdrArgs(options);
	assert.deepEqual(args.slice(-2), ["--tools", "read,bash,edit"]);
	assert.equal(buildHerdrArgs({ ...options, activeTools: [] }).at(-1), "--no-tools");
});

test("buildNativeBridgeMessage keeps side-pane policy in the suffix", () => {
	const message = buildNativeBridgeMessage("instructions here");
	assert.equal(message.role, "user");
	const text = (message.content as Array<{ text: string }>)[0]?.text ?? "";
	assert.match(text, /read-only snapshot of the parent session/);
	assert.match(text, /instructions here/);
});

test("payload creation and validation are versioned", () => {
	const payload = createPayload(fixturePayloadOptions());
	assert.equal(isBtwPayload(payload), true);
	assert.ok(payload.launchId.length > 0);
	assert.ok(payload.capability.length >= 64);
	assert.notEqual(createPayload(fixturePayloadOptions()).capability, payload.capability);
	assert.equal(isBtwPayload({ ...payload, version: 2 }), false);
	assert.equal(isBtwPayload({ ...payload, parentPaneId: 5 }), false);
	assert.equal(isBtwPayload({ ...payload, parentPaneId: null }), true);
	assert.equal(isBtwPayload({ ...payload, draftQuestion: null }), false);
	assert.equal(isBtwPayload({ ...payload, capability: "short" }), false);
	assert.equal(isBtwPayload({ ...payload, messages: [{ notRole: true }] }), false);
	assert.equal(isBtwPayload({ ...payload, config: { ...payload.config, tools: "write-only" } }), false);
});

test("launch result classification keeps killed launches ambiguous", () => {
	assert.equal(classifyLaunchResult({ code: 0 }), "success");
	assert.equal(classifyLaunchResult({ code: 1 }), "failed");
	assert.equal(classifyLaunchResult({ code: 1, killed: true }), "ambiguous");
	assert.equal(classifyLaunchResult({ code: 0, killed: true }), "ambiguous");
});

test("safeErrorText prefers stderr and limits output", () => {
	assert.equal(safeErrorText("stdout", "stderr"), "stderr");
	assert.equal(safeErrorText("stdout", ""), "stdout");
	assert.equal(safeErrorText("", ""), "Herdr failed to create the side pane");
	assert.equal(safeErrorText("", "x".repeat(600)).length, 500);
});
