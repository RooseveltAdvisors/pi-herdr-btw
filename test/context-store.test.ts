import assert from "node:assert/strict";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ContextStore } from "../src/context-store.ts";
import { createPayload } from "../src/core.ts";

async function createFixture(t: test.TestContext): Promise<{
	base: string;
	root: string;
	store: ContextStore;
}> {
	const base = await mkdtemp(join(tmpdir(), "pi-herdr-btw-test-"));
	t.after(async () => {
		const { rm } = await import("node:fs/promises");
		await rm(base, { recursive: true, force: true });
	});
	const root = join(base, "store");
	return { base, root, store: new ContextStore(root) };
}

function fixturePayload(question = "draft") {
	return createPayload("2026-07-15T00:00:00.000Z", "# Context", question);
}

test("ContextStore creates, reads, and removes a private launch payload", async (t) => {
	const { root, store } = await createFixture(t);
	const payload = fixturePayload("exact draft");
	const payloadPath = await store.create(payload);

	assert.deepEqual(await store.read(payloadPath), payload);
	if (process.platform !== "win32") {
		assert.equal((await lstat(root)).mode & 0o777, 0o700);
		assert.equal((await lstat(dirname(payloadPath))).mode & 0o777, 0o700);
		assert.equal((await lstat(payloadPath)).mode & 0o777, 0o600);
	}

	await store.remove(payloadPath);
	await assert.rejects(access(payloadPath), (error: unknown) => {
		assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
		return true;
	});
	await store.remove(payloadPath);
});

test("ContextStore removes the launch directory when payload creation fails", async (t) => {
	const { root, store } = await createFixture(t);
	const unserializable = {
		...fixturePayload(),
		contextDocument: 1n,
	} as unknown as ReturnType<typeof fixturePayload>;

	await assert.rejects(store.create(unserializable), /BigInt/);
	assert.deepEqual(await readdir(root), []);
});

test("ContextStore repairs an existing owned root to private permissions", async (t) => {
	const { root, store } = await createFixture(t);
	await mkdir(root, { mode: 0o755 });
	await chmod(root, 0o755);
	await store.create(fixturePayload());
	if (process.platform !== "win32") {
		assert.equal((await lstat(root)).mode & 0o777, 0o700);
	}
});

test("ContextStore rejects payloads outside its private root", async (t) => {
	const { base, store } = await createFixture(t);
	const outsideDir = join(base, "launch-outside");
	await mkdir(outsideDir, { mode: 0o700 });
	const outsidePath = join(outsideDir, "payload.json");
	await writeFile(outsidePath, JSON.stringify(fixturePayload()), { mode: 0o600 });

	await assert.rejects(store.read(outsidePath), /outside the private root/);
	await assert.rejects(store.remove(outsidePath), /outside the private root/);
});

test("ContextStore rejects symlink payloads", async (t) => {
	if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
	const { base, store } = await createFixture(t);
	const payloadPath = await store.create(fixturePayload());
	const targetPath = join(base, "target.json");
	await writeFile(targetPath, JSON.stringify(fixturePayload()), { mode: 0o600 });
	await import("node:fs/promises").then(({ rm }) => rm(payloadPath));
	await symlink(targetPath, payloadPath);

	await assert.rejects(store.read(payloadPath), /unsafe \/btw context payload/);
});

test("ContextStore rejects payload files with group or other permissions", async (t) => {
	if (process.platform === "win32") t.skip("POSIX mode checks do not apply on Windows");
	const { store } = await createFixture(t);
	const payloadPath = await store.create(fixturePayload());
	await chmod(payloadPath, 0o644);
	await assert.rejects(store.read(payloadPath), /group or other permissions/);
});

test("ContextStore removes stale launches and preserves fresh launches", async (t) => {
	const { store } = await createFixture(t);
	const stalePath = await store.create(fixturePayload("stale"));
	const freshPath = await store.create(fixturePayload("fresh"));
	const now = Date.now();
	await utimes(dirname(stalePath), new Date(now - 10_000), new Date(now - 10_000));
	await utimes(dirname(freshPath), new Date(now), new Date(now));

	await store.removeStale(5_000, now);
	await assert.rejects(access(stalePath));
	await access(freshPath);
});

test("ContextStore rejects invalid payload contents", async (t) => {
	const { store } = await createFixture(t);
	const payloadPath = await store.create(fixturePayload());
	await writeFile(payloadPath, '{"version":99}\n', { mode: 0o600 });
	await chmod(payloadPath, 0o600);
	await assert.rejects(store.read(payloadPath), /Invalid or unsupported/);
});
