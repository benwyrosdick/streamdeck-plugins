import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { type RawData, WebSocket, WebSocketServer } from "ws";

import { clientAuth, normalizeCode, randomNonce, sameDigest, serverProof } from "./pairing";
import { type KeyInfo, type ListItem, type ModuleMessage, PROTOCOL, type PluginMessage, type RejectReason, type View } from "./protocol";

/** How long a new connection has to answer the challenge. */
export const AUTH_TIMEOUT_MS = 5_000;
/** How long the inspector waits for a list from Foundry. */
export const REQUEST_TIMEOUT_MS = 4_000;
/** Connections still pairing at once; more are turned away. */
const MAX_PENDING = 4;
/** Wrong codes in a row before refusing all attempts for a while… */
const FAILURES_BEFORE_LOCK = 5;
/** …starting at this long and doubling, up to the cap. */
const LOCK_MS = 30_000;
const MAX_LOCK_MS = 600_000;
/** Largest message accepted: room for a batch of key thumbnails. */
const MAX_PAYLOAD = 4 * 1024 * 1024;

/** Who is connected, as the module introduced itself. */
export type ClientInfo = { world?: string; user?: string; isGM?: boolean; foundry?: string };

export type BridgeStatus =
	| { state: "starting" }
	| { state: "listening"; port: number; rejected?: RejectReason }
	| { state: "connected"; port: number; client: ClientInfo }
	| { state: "error"; port: number; message: string };

export type BridgeEvents = {
	status(status: BridgeStatus): void;
	views(views: Record<string, View>): void;
	pressed(id: string, ok: boolean, message?: string): void;
	/** A Foundry window finished pairing; send it the keys. */
	connected(): void;
	disconnected(): void;
};

type Pending = { resolve: (items: ListItem[] | undefined) => void; timer: ReturnType<typeof setTimeout> };

/**
 * The plugin's end of the bridge: a WebSocket server on 127.0.0.1 that one
 * paired Foundry window at a time connects to.
 *
 * A connection must prove it knows the pairing code within a few seconds or
 * it's closed; nothing but the challenge is ever sent to an unpaired socket.
 * Repeated wrong codes lock pairing for a while, so the code can't be
 * guessed. When a second window pairs, it replaces the first.
 */
export class BridgeServer {
	readonly #events: Partial<BridgeEvents>;
	readonly #now: () => number;
	readonly #authTimeoutMs: number;
	readonly #requestTimeoutMs: number;
	#http: Server | undefined;
	#wss: WebSocketServer | undefined;
	#client: WebSocket | undefined;
	#code = "";
	#port = 0;
	#pending = 0;
	#failures = 0;
	#lockedUntil = 0;
	#requestId = 0;
	readonly #requests = new Map<string, Pending>();
	#status: BridgeStatus = { state: "starting" };

	constructor(
		events: Partial<BridgeEvents> = {},
		{ now = Date.now, authTimeoutMs = AUTH_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS }: { now?: () => number; authTimeoutMs?: number; requestTimeoutMs?: number } = {},
	) {
		this.#events = events;
		this.#now = now;
		this.#authTimeoutMs = authTimeoutMs;
		this.#requestTimeoutMs = requestTimeoutMs;
	}

	get status(): BridgeStatus {
		return this.#status;
	}

	get connected(): boolean {
		return this.#client?.readyState === WebSocket.OPEN;
	}

	/** The port actually listened on (useful with port 0 in tests). */
	get port(): number {
		return this.#port;
	}

	/** Change the pairing code; the connected window (paired with the old one) is dropped. */
	setCode(code: string): void {
		const changed = normalizeCode(code) !== this.#code;
		this.#code = normalizeCode(code);
		if (changed && this.#client) {
			this.#client.close(4003, "code changed");
		}
	}

	/** Listen on `port` (127.0.0.1 only), restarting if already listening. */
	async start(port: number, code: string): Promise<void> {
		await this.stop();
		this.#code = normalizeCode(code);
		this.#port = port;
		const http = createServer((req, res) => {
			// A plain GET answers, so you can check the plugin is listening from a browser.
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("Stream Deck Bridge for Foundry VTT — OK\n");
		});
		const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });
		wss.on("connection", (socket) => this.#accept(socket));
		// ws re-emits the HTTP server's errors (e.g. port in use); they're reported below.
		wss.on("error", () => undefined);
		this.#http = http;
		this.#wss = wss;
		await new Promise<void>((resolve) => {
			http.once("error", (error: NodeJS.ErrnoException) => {
				const message = error.code === "EADDRINUSE" ? `Port ${port} is in use` : error.message;
				this.#setStatus({ state: "error", port, message });
				resolve();
			});
			http.listen(port, "127.0.0.1", () => {
				this.#port = (http.address() as AddressInfo).port;
				this.#setStatus({ state: "listening", port: this.#port });
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		for (const socket of this.#wss?.clients ?? []) {
			socket.terminate();
		}
		this.#client = undefined;
		await new Promise<void>((resolve) => (this.#wss ? this.#wss.close(() => resolve()) : resolve()));
		await new Promise<void>((resolve) => (this.#http?.listening ? this.#http.close(() => resolve()) : resolve()));
		this.#wss = undefined;
		this.#http = undefined;
	}

	/** Send to the paired window; false if there isn't one. */
	send(message: PluginMessage): boolean {
		if (!this.connected) {
			return false;
		}
		this.#client?.send(JSON.stringify(message));
		return true;
	}

	/** Ask Foundry for a list; `undefined` if it isn't connected or doesn't answer in time. */
	request(what: string): Promise<ListItem[] | undefined> {
		if (!this.connected) {
			return Promise.resolve(undefined);
		}
		const id = String(++this.#requestId);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#requests.delete(id);
				resolve(undefined);
			}, this.#requestTimeoutMs);
			this.#requests.set(id, { resolve, timer });
			this.send({ type: "request", id, what });
		});
	}

	#accept(socket: WebSocket): void {
		const reject = (reason: RejectReason, code = 4003) => {
			socket.send(JSON.stringify({ type: "rejected", reason } satisfies PluginMessage));
			socket.close(code, reason);
		};
		if (this.#now() < this.#lockedUntil) {
			reject("locked", 4029);
			return;
		}
		if (this.#pending >= MAX_PENDING) {
			reject("busy", 4029);
			return;
		}

		this.#pending++;
		let paired = false;
		let settled = false;
		const nonce = randomNonce();
		const timer = setTimeout(() => {
			if (!paired) reject("timeout", 4000);
		}, this.#authTimeoutMs);
		// Leaves the pending count exactly once, however the attempt ends.
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.#pending--;
		};
		socket.send(JSON.stringify({ type: "challenge", nonce, protocol: PROTOCOL } satisfies PluginMessage));

		socket.once("message", (data) => {
			const hello = parse(data);
			if (hello?.type !== "hello" || typeof hello.cnonce !== "string") {
				settle();
				reject("badMessage");
				return;
			}
			if (!this.#code || !sameDigest(hello.auth, clientAuth(this.#code, nonce))) {
				settle();
				this.#recordFailure();
				reject("badCode");
				return;
			}
			settle();
			paired = true;
			this.#failures = 0;
			socket.send(JSON.stringify({ type: "welcome", proof: serverProof(this.#code, hello.cnonce), protocol: PROTOCOL } satisfies PluginMessage));
			this.#adopt(socket, { world: hello.world, user: hello.user, isGM: hello.isGM, foundry: hello.foundry });
		});
		socket.on("close", settle);
		socket.on("error", () => undefined);
	}

	/** Make a freshly paired socket the active one, replacing any other window. */
	#adopt(socket: WebSocket, client: ClientInfo): void {
		const previous = this.#client;
		this.#client = socket;
		if (previous && previous !== socket) {
			previous.send(JSON.stringify({ type: "replaced" } satisfies PluginMessage));
			previous.close(4001, "replaced");
		}
		socket.on("message", (data) => this.#receive(parse(data)));
		socket.on("close", () => {
			if (this.#client !== socket) return;
			this.#client = undefined;
			for (const [id, pending] of this.#requests) {
				clearTimeout(pending.timer);
				pending.resolve(undefined);
				this.#requests.delete(id);
			}
			this.#setStatus({ state: "listening", port: this.#port });
			this.#events.disconnected?.();
		});
		this.#setStatus({ state: "connected", port: this.#port, client });
		this.#events.connected?.();
	}

	#receive(message: ModuleMessage | undefined): void {
		switch (message?.type) {
			case "views":
				if (message.views && typeof message.views === "object") {
					this.#events.views?.(message.views);
				}
				break;
			case "response": {
				const pending = this.#requests.get(String(message.id));
				if (pending) {
					clearTimeout(pending.timer);
					this.#requests.delete(String(message.id));
					pending.resolve(Array.isArray(message.items) ? message.items : []);
				}
				break;
			}
			case "pressed":
				this.#events.pressed?.(String(message.id), message.ok === true, message.message);
				break;
		}
	}

	#recordFailure(): void {
		this.#failures++;
		if (this.#failures >= FAILURES_BEFORE_LOCK) {
			const lock = Math.min(MAX_LOCK_MS, LOCK_MS * 2 ** (this.#failures - FAILURES_BEFORE_LOCK));
			this.#lockedUntil = this.#now() + lock;
		}
		if (this.#status.state !== "connected") {
			this.#setStatus({ state: "listening", port: this.#port, rejected: "badCode" });
		}
	}

	#setStatus(status: BridgeStatus): void {
		this.#status = status;
		this.#events.status?.(status);
	}
}

function parse(data: RawData): ModuleMessage | undefined {
	try {
		const message = JSON.parse(String(data)) as ModuleMessage;
		return message && typeof message === "object" ? message : undefined;
	} catch {
		return undefined;
	}
}

export type { KeyInfo };
