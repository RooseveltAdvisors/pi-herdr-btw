import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BtwPayload } from "./core.ts";

export const MERGE_PROTOCOL_VERSION = 1 as const;
export const MERGE_REQUEST_FILE = "merge-request.json";
export const MERGE_ACK_FILE = "merge-ack.json";
export const MERGE_CUSTOM_TYPE = "pi-herdr-btw.merge";
export const MAX_SUMMARY_BYTES = 64 * 1024;

export type MergeRequest = {
	protocolVersion: typeof MERGE_PROTOCOL_VERSION;
	requestId: string;
	launchId: string;
	parentSessionId: string;
	capability: string;
	createdAt: string;
	/** Trimmed, 1..64 KiB reviewed summary. */
	summary: string;
};

export type MergeAck = {
	protocolVersion: typeof MERGE_PROTOCOL_VERSION;
	requestId: string;
	status: "accepted" | "rejected";
	processedAt: string;
	reason?: string;
};

export function isMergeRequest(value: unknown): value is MergeRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<MergeRequest>;
	return (
		request.protocolVersion === MERGE_PROTOCOL_VERSION &&
		typeof request.requestId === "string" &&
		request.requestId.length > 0 &&
		typeof request.launchId === "string" &&
		request.launchId.length > 0 &&
		typeof request.parentSessionId === "string" &&
		request.parentSessionId.length > 0 &&
		typeof request.capability === "string" &&
		request.capability.length >= 32 &&
		typeof request.createdAt === "string" &&
		typeof request.summary === "string" &&
		isSummaryWithinBounds(request.summary)
	);
}

export function isMergeAck(value: unknown): value is MergeAck {
	if (!value || typeof value !== "object") return false;
	const ack = value as Partial<MergeAck>;
	return (
		ack.protocolVersion === MERGE_PROTOCOL_VERSION &&
		typeof ack.requestId === "string" &&
		ack.requestId.length > 0 &&
		(ack.status === "accepted" || ack.status === "rejected") &&
		typeof ack.processedAt === "string" &&
		(ack.reason === undefined || typeof ack.reason === "string")
	);
}

export function isSummaryWithinBounds(summary: string): boolean {
	const trimmed = summary.trim();
	return trimmed.length > 0 && Buffer.byteLength(trimmed, "utf8") <= MAX_SUMMARY_BYTES;
}

/**
 * A merge request is trusted only when it echoes the exact launch identity,
 * capability token, and parent session binding of its own launch payload.
 */
export function validateRequestAgainstPayload(
	request: MergeRequest,
	payload: BtwPayload,
): string | undefined {
	if (request.launchId !== payload.launchId) return "launch ID mismatch";
	if (request.capability !== payload.capability) return "capability mismatch";
	if (request.parentSessionId !== payload.parentSessionId) return "parent session mismatch";
	return undefined;
}

/** True when the ack acknowledges exactly the given (possibly malformed) request. */
export function ackMatchesRequest(ack: unknown, rawRequest: unknown): boolean {
	if (!isMergeAck(ack)) return false;
	const requestId =
		!!rawRequest && typeof rawRequest === "object" && typeof (rawRequest as { requestId?: unknown }).requestId === "string"
			? (rawRequest as { requestId: string }).requestId
			: undefined;
	// Malformed requests without a usable requestId are acked as "unknown".
	return ack.requestId === (requestId ?? "unknown");
}

export function buildMergeMessageContent(summary: string): string {
	return `Merged from /btw (reviewed reference material)\n\n<btw-merge>\n${summary.trim()}\n</btw-merge>`;
}

type EntryLike = {
	type: string;
	customType?: string;
	details?: unknown;
};

/** Deduplicate against already-persisted merge custom messages by requestId. */
export function hasMergedRequestId(entries: EntryLike[], requestId: string): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === MERGE_CUSTOM_TYPE &&
			!!entry.details &&
			typeof entry.details === "object" &&
			(entry.details as { requestId?: unknown }).requestId === requestId,
	);
}

/**
 * Extract the latest completed text-bearing assistant answer from the child's
 * effective messages as the default merge candidate.
 */
export function extractMergeCandidate(messages: AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string; content?: unknown };
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter(
				(block): block is { type: "text"; text: string } =>
					!!block && typeof block === "object" && block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

export type MergeStorePort = {
	listLaunchPayloadPaths(): Promise<string[]>;
	read(payloadPath: string): Promise<BtwPayload>;
	readMergeRequest(payloadPath: string): Promise<unknown>;
	readMergeAck(payloadPath: string): Promise<unknown>;
	writeMergeAck(payloadPath: string, ack: MergeAck): Promise<void>;
};

export type ParentSessionPort = {
	getSessionId(): string;
	isIdle(): boolean;
	getEntries(): EntryLike[];
	sendMergeMessage(content: string, details: { requestId: string; launchId: string }): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
};

export type ScanResult = {
	delivered: number;
	deferred: number;
	rejected: number;
};

/**
 * Parent-side merge coordinator. Scans the private launch store for pending
 * merge requests bound to the current parent session, delivers each exactly
 * once as a passive custom message, and acknowledges it.
 */
export class MergeCoordinator {
	constructor(
		private readonly store: MergeStorePort,
		private readonly session: ParentSessionPort,
		private readonly now: () => Date = () => new Date(),
	) {}

	private scanning = false;

	async scan(): Promise<ScanResult> {
		if (this.scanning) return { delivered: 0, deferred: 0, rejected: 0 };
		this.scanning = true;
		try {
			return await this.scanOnce();
		} finally {
			this.scanning = false;
		}
	}

	private async scanOnce(): Promise<ScanResult> {
		const result: ScanResult = { delivered: 0, deferred: 0, rejected: 0 };
		let payloadPaths: string[];
		try {
			payloadPaths = await this.store.listLaunchPayloadPaths();
		} catch {
			return result;
		}

		for (const payloadPath of payloadPaths) {
			try {
				await this.processLaunch(payloadPath, result);
			} catch {
				// Unsafe or unreadable launch directories are skipped, never trusted.
			}
		}
		return result;
	}

	private async processLaunch(payloadPath: string, result: ScanResult): Promise<void> {
		const rawRequest = await this.store.readMergeRequest(payloadPath);
		if (rawRequest === undefined) return;

		// Only an ack for THIS request means it was processed; a stale ack from an
		// earlier merge in the same launch must not mask a newer request.
		const ack = await this.store.readMergeAck(payloadPath);
		if (ackMatchesRequest(ack, rawRequest)) return;

		const payload = await this.store.read(payloadPath);
		// Only the session a launch is bound to may consume its merge requests.
		if (payload.parentSessionId !== this.session.getSessionId()) return;

		if (!isMergeRequest(rawRequest)) {
			await this.reject(payloadPath, rawRequest, "malformed merge request");
			result.rejected += 1;
			return;
		}
		const validationError = validateRequestAgainstPayload(rawRequest, payload);
		if (validationError) {
			await this.reject(payloadPath, rawRequest, validationError);
			result.rejected += 1;
			return;
		}

		if (hasMergedRequestId(this.session.getEntries(), rawRequest.requestId)) {
			// Append succeeded earlier but the ack write crashed; just re-ack.
			await this.acknowledge(payloadPath, rawRequest.requestId, "accepted");
			return;
		}

		if (!this.session.isIdle()) {
			// Never steer or queue a model turn mid-stream; retry on agent_settled.
			result.deferred += 1;
			return;
		}

		// Re-check the session binding immediately before appending.
		if (payload.parentSessionId !== this.session.getSessionId()) return;
		this.session.sendMergeMessage(buildMergeMessageContent(rawRequest.summary), {
			requestId: rawRequest.requestId,
			launchId: rawRequest.launchId,
		});
		await this.acknowledge(payloadPath, rawRequest.requestId, "accepted");
		this.session.notify("Merged a reviewed /btw summary into this session.", "info");
		result.delivered += 1;
	}

	private async reject(payloadPath: string, rawRequest: unknown, reason: string): Promise<void> {
		const requestId =
			!!rawRequest && typeof rawRequest === "object" && typeof (rawRequest as { requestId?: unknown }).requestId === "string"
				? ((rawRequest as { requestId: string }).requestId)
				: "unknown";
		await this.acknowledge(payloadPath, requestId, "rejected", reason);
		this.session.notify(`Rejected a /btw merge request: ${reason}`, "warning");
	}

	private async acknowledge(
		payloadPath: string,
		requestId: string,
		status: MergeAck["status"],
		reason?: string,
	): Promise<void> {
		await this.store.writeMergeAck(payloadPath, {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId,
			status,
			processedAt: this.now().toISOString(),
			...(reason ? { reason } : {}),
		});
	}
}
