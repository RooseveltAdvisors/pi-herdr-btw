import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerBtwExtension,
	type ContextStorePort,
} from "../src/index.ts";
import { createPayload, type BtwPayload } from "../src/core.ts";

type Command = {
	handler: (args: string, ctx: ReturnType<typeof createCommandContext>) => Promise<void>;
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
	readValue: BtwPayload = createPayload("2026-07-15T00:00:00.000Z", "# Context", "draft");
	readError: Error | undefined;

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
}

function createCommandContext() {
	const notifications: Array<{ message: string; type: string }> = [];
	const entries = [
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
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => "a1b2c3d4",
			getSessionId: () => "12345678-1234-1234-1234-123456789abc",
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
		},
		notifications,
	} as any;
}

async function createHarness(
	store: FakeStore,
	execImpl: (command: string, args: string[]) => Promise<ExecResult>,
) {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, EventHandler[]>();
	const execCalls: Array<{ command: string; args: string[] }> = [];
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
	} as unknown as ExtensionAPI;

	await registerBtwExtension(pi, { store });
	return { commands, handlers, execCalls };
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

test("parent command writes the question to the private payload and launches Herdr", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({
			code: 0,
			stdout: "ok",
			stderr: "",
		}));
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("  secret question  ", ctx);

		assert.equal(store.staleRuns, 1);
		assert.equal(store.created[0]?.draftQuestion, "secret question");
		assert.deepEqual(store.removed, []);
		assert.equal(harness.execCalls.length, 1);
		assert.equal(harness.execCalls[0]?.command, "herdr");
		assert.equal(harness.execCalls[0]?.args.some((arg) => arg.includes("secret question")), false);
		assert.ok(harness.execCalls[0]?.args.includes("PI_HERDR_BTW_PAYLOAD=/tmp/pi-herdr-btw-test/launch-123/payload.json"));
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

		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.deepEqual(ctx.notifications.at(-1), {
			message: "/btw failed: no server",
			type: "error",
		});
	});
});

test("parent command removes sensitive payload when pi.exec rejects before launch", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => {
			throw new Error("spawn herdr ENOENT");
		});
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);

		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.deepEqual(ctx.notifications.at(-1), {
			message: "/btw failed: spawn herdr ENOENT",
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

		assert.deepEqual(store.removed, []);
		assert.equal(ctx.notifications.at(-1)?.type, "warning");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /cleanup is deferred/);
	});
});

test("child mode blocks prompts when the private payload cannot be read", async () => {
	const previous = process.env.PI_HERDR_BTW_PAYLOAD;
	process.env.PI_HERDR_BTW_PAYLOAD = "/tmp/missing/payload.json";
	try {
		const store = new FakeStore();
		store.readError = new Error("payload missing");
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		assert.equal(harness.commands.has("btw"), false);
		const notifications: Array<{ message: string; type: string }> = [];
		const result = await harness.handlers.get("input")?.[0]?.(
			{ text: "question", source: "interactive" },
			{ ui: { notify: (message: string, type: string) => notifications.push({ message, type }) } },
		);
		assert.deepEqual(result, { action: "handled" });
		assert.deepEqual(notifications, [{ message: "/btw is blocked: payload missing", type: "error" }]);
	} finally {
		if (previous === undefined) delete process.env.PI_HERDR_BTW_PAYLOAD;
		else process.env.PI_HERDR_BTW_PAYLOAD = previous;
	}
});

test("child quit removes its private launch payload", async () => {
	const previous = process.env.PI_HERDR_BTW_PAYLOAD;
	process.env.PI_HERDR_BTW_PAYLOAD = "/tmp/pi-herdr-btw-test/launch-123/payload.json";
	try {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		await harness.handlers.get("session_shutdown")?.[0]?.({ reason: "reload" }, {});
		assert.deepEqual(store.removed, []);
		await harness.handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, {});
		assert.deepEqual(store.removed, [store.payloadPath]);
	} finally {
		if (previous === undefined) delete process.env.PI_HERDR_BTW_PAYLOAD;
		else process.env.PI_HERDR_BTW_PAYLOAD = previous;
	}
});
