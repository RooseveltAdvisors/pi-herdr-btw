import assert from "node:assert/strict";
import test from "node:test";
import {
	buildContextDocument,
	buildHerdrArgs,
	buildParentContextMessage,
	classifyLaunchResult,
	createPayload,
	isBtwPayload,
	safeErrorText,
} from "../src/core.ts";

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
	});
	assert.equal(args.includes("--workspace"), false);
	assert.equal(args.includes("--tab"), false);
});

test("payload creation and validation are versioned", () => {
	const payload = createPayload("2026-07-15T00:00:00.000Z", "context", "question");
	assert.equal(isBtwPayload(payload), true);
	assert.equal(isBtwPayload({ ...payload, version: 2 }), false);
	assert.equal(isBtwPayload({ ...payload, draftQuestion: null }), false);
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
