import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isBtwPayload, type BtwPayload } from "./core.ts";

const PAYLOAD_FILE = "payload.json";
const LAUNCH_PREFIX = "launch-";

export const DEFAULT_STALE_CONTEXT_MS = 24 * 60 * 60 * 1000;

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwnedByCurrentUser(uid: number, path: string): void {
	const expectedUid = currentUid();
	if (expectedUid !== undefined && uid !== expectedUid) {
		throw new Error(`Refusing /btw context path not owned by the current user: ${path}`);
	}
}

function assertPrivateMode(mode: number, path: string): void {
	if (process.platform !== "win32" && (mode & 0o077) !== 0) {
		throw new Error(`Refusing /btw context path with group or other permissions: ${path}`);
	}
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function defaultContextRoot(): string {
	const uid = currentUid();
	return join(tmpdir(), uid === undefined ? "pi-herdr-btw" : `pi-herdr-btw-${uid}`);
}

export class ContextStore {
	readonly root: string;
	private canonicalRoot: string | undefined;

	constructor(root = defaultContextRoot()) {
		this.root = resolve(root);
	}

	async create(payload: BtwPayload): Promise<string> {
		const root = await this.ensureRoot();
		const launchDir = await mkdtemp(join(root, LAUNCH_PREFIX));
		try {
			await chmod(launchDir, 0o700);

			const payloadPath = join(launchDir, PAYLOAD_FILE);
			await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await chmod(payloadPath, 0o600);
			return payloadPath;
		} catch (error) {
			await rm(launchDir, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	async read(payloadPath: string): Promise<BtwPayload> {
		const canonicalPath = await this.validatePayloadPath(payloadPath);
		const parsed: unknown = JSON.parse(await readFile(canonicalPath, "utf8"));
		if (!isBtwPayload(parsed)) {
			throw new Error("Invalid or unsupported /btw context payload");
		}
		return parsed;
	}

	async remove(payloadPath: string): Promise<void> {
		const launchDir = await this.validateLaunchDir(payloadPath, true);
		if (launchDir) await rm(launchDir, { recursive: true, force: true });
	}

	async removeStale(
		maxAgeMs = DEFAULT_STALE_CONTEXT_MS,
		now = Date.now(),
	): Promise<void> {
		const root = await this.ensureRoot();
		const entries = await readdir(root, { withFileTypes: true });
		await Promise.all(
			entries.map(async (entry) => {
				if (!entry.name.startsWith(LAUNCH_PREFIX) || !entry.isDirectory()) return;
				const launchDir = join(root, entry.name);
				const info = await lstat(launchDir).catch(() => undefined);
				if (!info?.isDirectory() || info.isSymbolicLink()) return;
				assertOwnedByCurrentUser(info.uid, launchDir);
				if (info.mtimeMs < now - maxAgeMs) {
					await rm(launchDir, { recursive: true, force: true });
				}
			}),
		);
	}

	private async ensureRoot(): Promise<string> {
		if (this.canonicalRoot) return this.canonicalRoot;

		try {
			await mkdir(this.root, { mode: 0o700 });
		} catch (error) {
			if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
		}

		const info = await lstat(this.root);
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error(`Refusing unsafe /btw context root: ${this.root}`);
		}
		assertOwnedByCurrentUser(info.uid, this.root);
		await chmod(this.root, 0o700);
		const canonicalRoot = await realpath(this.root);
		const canonicalInfo = await lstat(canonicalRoot);
		assertOwnedByCurrentUser(canonicalInfo.uid, canonicalRoot);
		assertPrivateMode(canonicalInfo.mode, canonicalRoot);
		this.canonicalRoot = canonicalRoot;
		return canonicalRoot;
	}

	private async validatePayloadPath(payloadPath: string): Promise<string> {
		const launchDir = await this.validateLaunchDir(payloadPath, false);
		if (!launchDir) throw new Error(`Missing /btw context payload: ${payloadPath}`);

		const candidate = join(launchDir, PAYLOAD_FILE);
		const info = await lstat(candidate);
		if (!info.isFile() || info.isSymbolicLink()) {
			throw new Error(`Refusing unsafe /btw context payload: ${candidate}`);
		}
		assertOwnedByCurrentUser(info.uid, candidate);
		assertPrivateMode(info.mode, candidate);

		const canonicalPath = await realpath(candidate);
		const root = await this.ensureRoot();
		if (!isInside(root, canonicalPath)) {
			throw new Error(`Refusing /btw context payload outside the private root: ${payloadPath}`);
		}
		return canonicalPath;
	}

	private async validateLaunchDir(
		payloadPath: string,
		allowMissing: boolean,
	): Promise<string | undefined> {
		const root = await this.ensureRoot();
		const absolutePayload = resolve(payloadPath);
		const launchDir = dirname(absolutePayload);
		if (basename(absolutePayload) !== PAYLOAD_FILE || !basename(launchDir).startsWith(LAUNCH_PREFIX)) {
			throw new Error(`Refusing invalid /btw context payload path: ${payloadPath}`);
		}
		if (!isInside(root, launchDir)) {
			throw new Error(`Refusing /btw context payload outside the private root: ${payloadPath}`);
		}

		let info;
		try {
			info = await lstat(launchDir);
		} catch (error) {
			if (allowMissing && isMissing(error)) return undefined;
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink()) {
			throw new Error(`Refusing unsafe /btw launch directory: ${launchDir}`);
		}
		assertOwnedByCurrentUser(info.uid, launchDir);
		assertPrivateMode(info.mode, launchDir);

		const canonicalLaunchDir = await realpath(launchDir);
		if (!isInside(root, canonicalLaunchDir)) {
			throw new Error(`Refusing /btw launch directory outside the private root: ${launchDir}`);
		}
		return canonicalLaunchDir;
	}
}
