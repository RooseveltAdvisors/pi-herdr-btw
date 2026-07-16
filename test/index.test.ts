import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type BtwConfig } from "../src/config.ts";
import type { BtwPayload } from "../src/core.ts";
import {
	MERGE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	type MergeAck,
	type MergeRequest,
} from "../src/merge.ts";
import {
	decideCacheMode,
	registerBtwExtension,
	type ConfigStorePort,
	type ContextStorePort,
} from "../src/index.ts";
import { fixturePayload } from "./fixtures.ts";

type Command = {
	handler: (args: string, ctx: any) => Promise<void>;
};

type EventHandler = (event: any, ctx: any) => any;

type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
};

class FakeStore implements ContextStorePort {
	readonly payloadPath = "/tmp/pi-herdr-btw-test/launch-123/payload.json";
	readonly created: BtwPayload[] = [];
	readonly removed: string[] = [];
	staleRuns = 0;
	readValue: BtwPayload = fixturePayload({ draftQuestion: "draft" });
	readError: Error | undefined;
	mergeRequest: unknown;
	mergeAck: MergeAck | undefined;
	retained = 0;

	async create(payload: BtwPayload): Promise<string> {
		this.created.push(payload);
		return this.payloadPath;
	}

	async read(_payloadPath: string): Promise<BtwPayload> {
		if (this.readError) throw this.readError;
		return this.readValue;
	}

	async remove(payloadPath: string): Promise<void> {
		this.removed.push(payloadPath);
	}

	async removeStale(): Promise<void> {
		this.staleRuns += 1;
	}

	async listLaunchPayloadPaths(): Promise<string[]> {
		return [this.payloadPath];
	}

	async writeMergeRequest(_payloadPath: string, request: MergeRequest): Promise<void> {
		this.mergeRequest = request;
	}

	async readMergeRequest(_payloadPath: string): Promise<unknown> {
		return this.mergeRequest;
	}

	async writeMergeAck(_payloadPath: string, ack: MergeAck): Promise<void> {
		this.mergeAck = ack;
	}

	async readMergeAck(_payloadPath: string): Promise<unknown> {
		return this.mergeAck;
	}

	async removeIfNoPendingMerge(payloadPath: string): Promise<boolean> {
		if (this.mergeRequest !== undefined && this.mergeAck === undefined) {
			this.retained += 1;
			return false;
		}
		this.removed.push(payloadPath);
		return true;
	}
}

class FakeConfigStore implements ConfigStorePort {
	config: BtwConfig = { ...DEFAULT_CONFIG };
	readonly saved: BtwConfig[] = [];
	resetRuns = 0;
	loadError: Error | undefined;

	async load(): Promise<BtwConfig> {
		if (this.loadError) throw this.loadError;
		return { ...this.config };
	}

	async save(config: BtwConfig): Promise<void> {
		this.config = { ...config };
		this.saved.push({ ...config });
	}

	async reset(): Promise<BtwConfig> {
		this.config = { ...DEFAULT_CONFIG };
		this.loadError = undefined;
		this.resetRuns += 1;
		return { ...this.config };
	}
}

function createCommandContext() {
	const notifications: Array<{ message: string; type: string }> = [];
	const entries: any[] = [
		{
			type: "message",
			id: "a1b2c3d4",
			parentId: null,
			timestamp: "2026-07-15T00:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "parent question" }],
				timestamp: 1,
			},
		},
	];
	return {
		mode: "tui" as const,
		hasUI: true,
		cwd: "/tmp/project",
		model: { provider: "test-provider", id: "test-model" },
		isIdle: () => true,
		getSystemPrompt: () => "parent system prompt",
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => "a1b2c3d4",
			getSessionId: () => "12345678-1234-1234-1234-123456789abc",
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			editor: async (_title: string, prefill?: string) => prefill,
		},
		notifications,
		entries,
	} as any;
}

async function createHarness(
	store: FakeStore,
	execImpl: (command: string, args: string[]) => Promise<ExecResult>,
	configStore = new FakeConfigStore(),
) {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, EventHandler[]>();
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const sentUserMessages: string[] = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const timers: Array<ReturnType<typeof setInterval>> = [];
	const originalSetInterval = globalThis.setInterval;
	const pi = {
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		on(name: string, handler: EventHandler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args });
			return execImpl(command, args);
		},
		getThinkingLevel: () => "high",
		getActiveTools: () => ["read", "bash"],
		sendUserMessage: (message: string) => sentUserMessages.push(message),
		sendMessage: (message: any, options: any) => sentMessages.push({ message, options }),
	} as unknown as ExtensionAPI;

	// Capture timers created during registration/handlers so tests can clear them.
	(globalThis as any).setInterval = (...args: Parameters<typeof setInterval>) => {
		const timer = originalSetInterval(...args);
		timers.push(timer);
		return timer;
	};
	try {
		await registerBtwExtension(pi, { store, configStore });
	} finally {
		(globalThis as any).setInterval = originalSetInterval;
	}

	async function emit(name: string, event: any, ctx: any) {
		const results = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}

	function cleanup() {
		for (const timer of timers) clearInterval(timer);
	}

	return { commands, handlers, execCalls, sentUserMessages, sentMessages, configStore, emit, cleanup, timers };
}

async function withParentEnvironment(run: () => Promise<void>): Promise<void> {
	const previous = {
		payload: process.env.PI_HERDR_BTW_PAYLOAD,
		herdr: process.env.HERDR_ENV,
		pane: process.env.HERDR_PANE_ID,
		workspace: process.env.HERDR_WORKSPACE_ID,
		tab: process.env.HERDR_TAB_ID,
	};
	delete process.env.PI_HERDR_BTW_PAYLOAD;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "w1:p1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.HERDR_TAB_ID = "w1:t1";
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries({
			PI_HERDR_BTW_PAYLOAD: previous.payload,
			HERDR_ENV: previous.herdr,
			HERDR_PANE_ID: previous.pane,
			HERDR_WORKSPACE_ID: previous.workspace,
			HERDR_TAB_ID: previous.tab,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function withChildEnvironment(payloadPath: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env.PI_HERDR_BTW_PAYLOAD;
	process.env.PI_HERDR_BTW_PAYLOAD = payloadPath;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_HERDR_BTW_PAYLOAD;
		else process.env.PI_HERDR_BTW_PAYLOAD = previous;
	}
}

test("parent command captures native context and launches Herdr without leaking the question", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({
			code: 0,
			stdout: "ok",
			stderr: "",
		}));
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("  secret question  ", ctx);
		harness.cleanup();

		assert.equal(store.staleRuns, 1);
		const payload = store.created[0];
		assert.equal(payload?.draftQuestion, "secret question");
		assert.equal(payload?.parentSessionId, "12345678-1234-1234-1234-123456789abc");
		assert.equal(payload?.parentSystemPrompt, "parent system prompt");
		assert.deepEqual(payload?.parentActiveTools, ["read", "bash"]);
		assert.equal(payload?.parentThinkingLevel, "high");
		assert.equal(payload?.messages.length, 1);
		assert.ok(payload?.launchId);
		assert.ok((payload?.capability.length ?? 0) >= 64);
		assert.deepEqual(store.removed, []);
		assert.equal(harness.execCalls.length, 1);
		assert.equal(harness.execCalls[0]?.command, "herdr");
		const args = harness.execCalls[0]?.args ?? [];
		assert.equal(args.some((arg) => arg.includes("secret question")), false);
		assert.equal(args.some((arg) => arg.includes(payload?.capability ?? "!")), false);
		assert.ok(args.includes("PI_HERDR_BTW_PAYLOAD=/tmp/pi-herdr-btw-test/launch-123/payload.json"));
		// tools inherit (default) passes the exact active parent tool set
		assert.deepEqual(args.slice(-2), ["--tools", "read,bash"]);
	});
});

test("parent command routes ask, help, and unknown words by exact first word", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		const command = harness.commands.get("btw");

		await command?.handler("help", ctx);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /\/btw ask/);
		assert.equal(store.created.length, 0);

		await command?.handler("ask merge sort", ctx);
		assert.equal(store.created.at(-1)?.draftQuestion, "merge sort");

		await command?.handler("configuration options?", ctx);
		assert.equal(store.created.at(-1)?.draftQuestion, "configuration options?");
		harness.cleanup();
	});
});

test("config routes before Herdr and model launch checks", async () => {
	const previous = { payload: process.env.PI_HERDR_BTW_PAYLOAD, herdr: process.env.HERDR_ENV };
	delete process.env.PI_HERDR_BTW_PAYLOAD;
	delete process.env.HERDR_ENV; // not inside Herdr at all
	try {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		ctx.model = undefined; // and no model either
		await harness.commands.get("btw")?.handler("config auto-submit on", ctx);
		harness.cleanup();

		assert.equal(harness.configStore.config.autoSubmit, true);
		assert.equal(ctx.notifications.at(-1)?.type, "info");
		assert.equal(harness.execCalls.length, 0);
	} finally {
		if (previous.payload !== undefined) process.env.PI_HERDR_BTW_PAYLOAD = previous.payload;
		if (previous.herdr !== undefined) process.env.HERDR_ENV = previous.herdr;
	}
});

test("config subcommand updates and resets launch defaults, including malformed-config recovery", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		const command = harness.commands.get("btw");

		await command?.handler("config auto-submit on", ctx);
		await command?.handler("config model anthropic/claude-sonnet", ctx);
		await command?.handler("config tools read-only", ctx);
		harness.cleanup();

		assert.equal(harness.configStore.config.autoSubmit, true);
		assert.equal(harness.configStore.config.model, "anthropic/claude-sonnet");
		assert.equal(harness.configStore.config.tools, "read-only");
		assert.equal(harness.configStore.saved.length, 3);

		harness.configStore.loadError = new Error("malformed config");
		await command?.handler("config reset", ctx);
		assert.deepEqual(harness.configStore.config, DEFAULT_CONFIG);
		assert.equal(harness.configStore.resetRuns, 1);
	});
});

test("parent command removes sensitive payload after a definite nonzero launch failure", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({
			code: 1,
			stdout: "",
			stderr: "no server",
		}));
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.deepEqual(ctx.notifications.at(-1), {
			message: "/btw failed: no server",
			type: "error",
		});
	});
});

test("parent command retains payload for an ambiguous killed launch", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({
			code: 1,
			stdout: "",
			stderr: "timeout",
			killed: true,
		}));
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(store.removed, []);
		assert.equal(ctx.notifications.at(-1)?.type, "warning");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /cleanup is deferred/);
	});
});

test("parent command applies configured model, thinking, tools, and split", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const configStore = new FakeConfigStore();
		configStore.config = {
			autoSubmit: true,
			model: "anthropic/claude-haiku",
			thinking: "low",
			tools: "none",
			split: "down",
		};
		const harness = await createHarness(
			store,
			async () => ({ code: 0, stdout: "", stderr: "" }),
			configStore,
		);
		await harness.commands.get("btw")?.handler("question", createCommandContext());
		harness.cleanup();

		assert.deepEqual(store.created[0]?.config, configStore.config);
		const args = harness.execCalls[0]?.args ?? [];
		assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
			"--model",
			"anthropic/claude-haiku",
		]);
		assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), [
			"--thinking",
			"low",
		]);
		assert.deepEqual(args.slice(args.indexOf("--split"), args.indexOf("--split") + 2), [
			"--split",
			"down",
		]);
		assert.equal(args.at(-1), "--no-tools");
	});
});

test("parent merge scan delivers a pending, validated merge as a passive custom message", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-42",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: payload.capability,
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "reviewed summary from the side thread",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();

		await harness.commands.get("btw")?.handler("merge", ctx);
		harness.cleanup();

		assert.equal(harness.sentMessages.length, 1);
		const sent = harness.sentMessages[0];
		assert.equal(sent?.message.customType, MERGE_CUSTOM_TYPE);
		assert.equal(sent?.message.display, true);
		assert.match(sent?.message.content ?? "", /<btw-merge>\nreviewed summary from the side thread\n<\/btw-merge>/);
		assert.deepEqual(sent?.options, { triggerTurn: false });
		assert.equal(store.mergeAck?.status, "accepted");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /delivered 1/);
	});
});

test("parent defers merge delivery while busy and delivers on agent_settled", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-busy",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: payload.capability,
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "deferred summary",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		let idle = false;
		ctx.isIdle = () => idle;

		await harness.commands.get("btw")?.handler("merge", ctx);
		assert.equal(harness.sentMessages.length, 0);
		assert.equal(store.mergeAck, undefined);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /pending/);

		idle = true;
		await harness.emit("agent_settled", {}, ctx);
		harness.cleanup();
		assert.equal(harness.sentMessages.length, 1);
		assert.equal((store.mergeAck as MergeAck | undefined)?.status, "accepted");
	});
});

test("parent rejects merges that fail capability validation", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-forged",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: "f".repeat(64),
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "forged summary",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();

		await harness.commands.get("btw")?.handler("merge", ctx);
		harness.cleanup();

		assert.equal(harness.sentMessages.length, 0);
		assert.equal(store.mergeAck?.status, "rejected");
		assert.match(store.mergeAck?.reason ?? "", /capability/);
	});
});

test("child mode blocks prompts when the private payload cannot be read", async () => {
	await withChildEnvironment("/tmp/missing/payload.json", async () => {
		const store = new FakeStore();
		store.readError = new Error("payload missing");
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const notifications: Array<{ message: string; type: string }> = [];
		const result = await harness.handlers.get("input")?.[0]?.(
			{ text: "question", source: "interactive" },
			{ ui: { notify: (message: string, type: string) => notifications.push({ message, type }) } },
		);
		assert.deepEqual(result, { action: "handled" });
		assert.deepEqual(notifications, [{ message: "/btw is blocked: payload missing", type: "error" }]);
	});
});

test("child quit keeps the launch directory while a merge is unacknowledged", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();

		await harness.emit("session_shutdown", { reason: "reload" }, {});
		assert.deepEqual(store.removed, []);

		// pending unacked merge -> retained
		store.mergeRequest = { requestId: "req-1" };
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		assert.deepEqual(store.removed, []);
		assert.equal(store.retained, 1);

		// acknowledged -> removed
		store.mergeAck = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-1",
			status: "accepted",
			processedAt: "2026-07-15T00:06:00.000Z",
		};
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		assert.deepEqual(store.removed, [store.payloadPath]);
	});
});

test("child auto-submits a configured draft question", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		store.readValue = fixturePayload({
			draftQuestion: "submit this",
			config: { ...DEFAULT_CONFIG, autoSubmit: true, tools: "none" },
		});
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const editorText: string[] = [];
		const widgets: string[][] = [];
		await harness.emit(
			"session_start",
			{ reason: "startup" },
			{
				mode: "tui",
				ui: {
					setTitle: () => undefined,
					setWidget: (_name: string, lines: string[]) => widgets.push(lines),
					setEditorText: (text: string) => editorText.push(text),
					theme: { fg: (_color: string, text: string) => text },
				},
			},
		);

		assert.deepEqual(harness.sentUserMessages, ["submit this"]);
		assert.deepEqual(editorText, []);
		assert.match(widgets[0]?.join("\n") ?? "", /tool-free/);
		assert.match(widgets[0]?.join("\n") ?? "", /tools are disabled/i);
	});
});

test("child uses the native prefix when model, tools, and thinking match the parent", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const ctx = { model: { provider: "test-provider", id: "test-model" } };

		const [startResult] = await harness.emit(
			"before_agent_start",
			{ systemPrompt: "child default prompt" },
			ctx,
		);
		assert.deepEqual(startResult, { systemPrompt: "parent system prompt" });

		const [contextResult] = await harness.emit(
			"context",
			{ messages: [{ role: "user", content: [{ type: "text", text: "side question" }], timestamp: 9 }] },
			ctx,
		);
		const messages = contextResult?.messages ?? [];
		// exact parent prefix, then the bridge suffix, then the child's own messages
		assert.deepEqual(messages[0], store.readValue.messages[0]);
		assert.match(messages[1]?.content?.[0]?.text ?? "", /read-only snapshot of the parent session/);
		assert.match(messages[1]?.content?.[0]?.text ?? "", /side pane/);
		assert.equal(messages.at(-1)?.content?.[0]?.text, "side question");
	});
});

test("child falls back to the portable document when the prefix cannot match", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		store.readValue = fixturePayload({ config: { ...DEFAULT_CONFIG, tools: "read-only" } });
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const ctx = { model: { provider: "test-provider", id: "test-model" } };

		const [startResult] = await harness.emit(
			"before_agent_start",
			{ systemPrompt: "child default prompt" },
			ctx,
		);
		assert.match(startResult?.systemPrompt ?? "", /^child default prompt/);
		assert.match(startResult?.systemPrompt ?? "", /side pane/);

		const [contextResult] = await harness.emit(
			"context",
			{ messages: [{ role: "user", content: [{ type: "text", text: "side question" }], timestamp: 9 }] },
			ctx,
		);
		const messages = contextResult?.messages ?? [];
		assert.equal(messages.length, 2);
		assert.match(messages[0]?.content?.[0]?.text ?? "", /read-only snapshot/);
		assert.match(messages[0]?.content?.[0]?.text ?? "", /<parent-conversation>/);
	});
});

test("decideCacheMode explains every fallback reason", () => {
	const payload = fixturePayload();
	const matching = {
		model: "test-provider/test-model",
		activeTools: ["read", "bash"],
		thinkingLevel: "high",
	};
	assert.deepEqual(decideCacheMode(payload, matching), { mode: "native" });
	const noPrompt = decideCacheMode(fixturePayload({ parentSystemPrompt: null }), matching);
	assert.match(noPrompt.reason ?? "", /system prompt/);
	assert.match(
		decideCacheMode(payload, { ...matching, model: "other/model" }).reason ?? "",
		/model/,
	);
	assert.match(
		decideCacheMode(payload, { ...matching, activeTools: ["read"] }).reason ?? "",
		/tool/,
	);
	assert.match(
		decideCacheMode(payload, { ...matching, thinkingLevel: "low" }).reason ?? "",
		/thinking/,
	);
	assert.match(
		decideCacheMode(
			fixturePayload({ config: { ...DEFAULT_CONFIG, model: "anthropic/claude-haiku" } }),
			matching,
		).reason ?? "",
		/model/,
	);
});

test("child merge opens a reviewed editor and writes a bounded request", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const command = harness.commands.get("btw");
		assert.ok(command);

		const editorCalls: Array<{ title: string; prefill?: string }> = [];
		const notifications: Array<{ message: string; type: string }> = [];
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{
						type: "message",
						id: "m1",
						parentId: null,
						timestamp: "2026-07-15T00:00:00.000Z",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "the side answer" }],
							timestamp: 2,
						},
					},
				],
				getLeafId: () => "m1",
			},
			ui: {
				notify: (message: string, type: string) => notifications.push({ message, type }),
				editor: async (title: string, prefill?: string) => {
					editorCalls.push({ title, prefill });
					return "  edited summary  ";
				},
			},
		};

		const originalSetInterval = globalThis.setInterval;
		const timers: Array<ReturnType<typeof setInterval>> = [];
		(globalThis as any).setInterval = (...args: Parameters<typeof setInterval>) => {
			const timer = originalSetInterval(...args);
			timers.push(timer);
			return timer;
		};
		try {
			await command?.handler("merge", ctx);
		} finally {
			(globalThis as any).setInterval = originalSetInterval;
			for (const timer of timers) clearInterval(timer);
		}

		assert.equal(editorCalls[0]?.prefill, "the side answer");
		const request = store.mergeRequest as MergeRequest;
		assert.equal(request.summary, "edited summary");
		assert.equal(request.launchId, store.readValue.launchId);
		assert.equal(request.capability, store.readValue.capability);
		assert.equal(request.parentSessionId, store.readValue.parentSessionId);
		assert.match(notifications.at(-1)?.message ?? "", /Merge pending/);
	});
});

test("child merge cancellation writes nothing", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const notifications: Array<{ message: string; type: string }> = [];
		const ctx = {
			sessionManager: { getEntries: () => [], getLeafId: () => null },
			ui: {
				notify: (message: string, type: string) => notifications.push({ message, type }),
				editor: async () => undefined,
			},
		};
		await harness.commands.get("btw")?.handler("merge", ctx);
		assert.equal(store.mergeRequest, undefined);
		assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
	});
});

test("child merge refuses to stack a second request on a pending one", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		store.mergeRequest = { requestId: "req-1" };
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const notifications: Array<{ message: string; type: string }> = [];
		const ctx = {
			sessionManager: { getEntries: () => [], getLeafId: () => null },
			ui: {
				notify: (message: string, type: string) => notifications.push({ message, type }),
				editor: async () => "should not be reached",
			},
		};
		await harness.commands.get("btw")?.handler("merge", ctx);
		assert.deepEqual(store.mergeRequest, { requestId: "req-1" });
		assert.match(notifications.at(-1)?.message ?? "", /already pending/);
	});
});
