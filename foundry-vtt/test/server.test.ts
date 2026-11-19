import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { clientAuth, serverProof } from "../src/bridge/pairing";
import type { PluginMessage } from "../src/bridge/protocol";
import { BridgeServer, type BridgeEvents } from "../src/bridge/server";

const CODE = "K7QM-3XWD";
const servers: BridgeServer[] = [];

async function startServer(events: Partial<BridgeEvents> = {}, options: ConstructorParameters<typeof BridgeServer>[1] = {}) {
	const server = new BridgeServer(events, { authTimeoutMs: 200, requestTimeoutMs: 200, ...options });
	servers.push(server);
	await server.start(0, CODE);
	return server;
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

/** A test client that records every message and the close code. */
function client(port: number) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`);
	const messages: PluginMessage[] = [];
	let closed: number | undefined;
	const waiters: (() => void)[] = [];
	socket.on("message", (data) => {
		messages.push(JSON.parse(String(data)));
		waiters.splice(0).forEach((w) => w());
	});
	socket.on("close", (code) => {
		closed = code;
		waiters.splice(0).forEach((w) => w());
	});
	const until = async (check: () => boolean, ms = 2_000) => {
		const deadline = Date.now() + ms;
		while (!check()) {
			if (Date.now() > deadline) throw new Error("timed out");
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
				setTimeout(resolve, 20);
			});
		}
	};
	const next = async (type: PluginMessage["type"]) => {
		await until(() => messages.some((m) => m.type === type));
		return messages.find((m) => m.type === type) as PluginMessage;
	};
	/** Answer the challenge with `code`. */
	const pair = async (code = CODE, cnonce = "abc123") => {
		const challenge = (await next("challenge")) as Extract<PluginMessage, { type: "challenge" }>;
		socket.send(JSON.stringify({ type: "hello", auth: clientAuth(code, challenge.nonce), cnonce, world: "Test World", user: "GM", isGM: true }));
	};
	return { socket, messages, next, pair, until, closed: () => closed };
}

describe("BridgeServer pairing", () => {
	it("pairs a client that knows the code, and proves it knows it too", async () => {
		const connected = vi.fn();
		const status = vi.fn();
		const server = await startServer({ connected, status });
		const c = client(server.port);
		await c.pair();
		const welcome = (await c.next("welcome")) as Extract<PluginMessage, { type: "welcome" }>;
		expect(welcome.proof).toBe(serverProof(CODE, "abc123"));
		await c.until(() => server.connected);
		expect(connected).toHaveBeenCalledTimes(1);
		expect(status).toHaveBeenLastCalledWith({ state: "connected", port: server.port, client: { world: "Test World", user: "GM", isGM: true, foundry: undefined } });
	});

	it("accepts the code typed without the dash or in lower case", async () => {
		const server = await startServer();
		const c = client(server.port);
		await c.pair("k7qm3xwd");
		await c.next("welcome");
	});

	it("rejects a wrong code and says so in the status", async () => {
		const status = vi.fn();
		const server = await startServer({ status });
		const c = client(server.port);
		await c.pair("WRONG-CODE");
		expect(await c.next("rejected")).toEqual({ type: "rejected", reason: "badCode" });
		await c.until(() => c.closed() !== undefined);
		expect(c.closed()).toBe(4003);
		expect(server.connected).toBe(false);
		expect(status).toHaveBeenLastCalledWith({ state: "listening", port: server.port, rejected: "badCode" });
	});

	it("closes a connection that never answers the challenge", async () => {
		const server = await startServer();
		const c = client(server.port);
		expect(await c.next("rejected")).toEqual({ type: "rejected", reason: "timeout" });
	});

	it("rejects anything but a hello first", async () => {
		const server = await startServer();
		const c = client(server.port);
		await c.next("challenge");
		c.socket.send(JSON.stringify({ type: "views", views: {} }));
		expect(await c.next("rejected")).toEqual({ type: "rejected", reason: "badMessage" });
	});

	it("locks pairing after repeated wrong codes, even for the right code", async () => {
		let now = 1_000;
		const server = await startServer({}, { now: () => now });
		for (let i = 0; i < 5; i++) {
			const c = client(server.port);
			await c.pair("WRONG-CODE");
			await c.next("rejected");
		}
		const locked = client(server.port);
		expect(await locked.next("rejected")).toEqual({ type: "rejected", reason: "locked" });
		now += 30_000;
		const ok = client(server.port);
		await ok.pair();
		await ok.next("welcome");
	});

	it("lets a new window replace the old one", async () => {
		const server = await startServer();
		const first = client(server.port);
		await first.pair();
		await first.next("welcome");
		const second = client(server.port);
		await second.pair();
		await second.next("welcome");
		expect(await first.next("replaced")).toEqual({ type: "replaced" });
		await first.until(() => first.closed() !== undefined);
		expect(server.connected).toBe(true);
	});

	it("drops the connected window when the code changes", async () => {
		const disconnected = vi.fn();
		const server = await startServer({ disconnected });
		const c = client(server.port);
		await c.pair();
		await c.next("welcome");
		server.setCode("NEWC-ODE2");
		await c.until(() => c.closed() !== undefined);
		await c.until(() => disconnected.mock.calls.length > 0);
	});
});

describe("BridgeServer messages", () => {
	async function paired(events: Partial<BridgeEvents> = {}) {
		const server = await startServer(events);
		const c = client(server.port);
		await c.pair();
		await c.next("welcome");
		await c.until(() => server.connected);
		return { server, c };
	}

	it("relays views and press results", async () => {
		const views = vi.fn();
		const pressed = vi.fn();
		const { c } = await paired({ views, pressed });
		c.socket.send(JSON.stringify({ type: "views", views: { k1: { title: "Hi" } } }));
		c.socket.send(JSON.stringify({ type: "pressed", id: "k1", ok: false, message: "No macro" }));
		await c.until(() => pressed.mock.calls.length > 0);
		expect(views).toHaveBeenCalledWith({ k1: { title: "Hi" } });
		expect(pressed).toHaveBeenCalledWith("k1", false, "No macro");
	});

	it("matches list requests to their responses, and times out", async () => {
		const { server, c } = await paired();
		const answer = server.request("macros");
		const request = (await c.next("request")) as Extract<PluginMessage, { type: "request" }>;
		expect(request.what).toBe("macros");
		c.socket.send(JSON.stringify({ type: "response", id: request.id, items: [{ id: "m1", name: "Fireball" }] }));
		expect(await answer).toEqual([{ id: "m1", name: "Fireball" }]);
		expect(await server.request("scenes")).toBeUndefined();
	});

	it("sends nothing and answers no requests without a client", async () => {
		const server = await startServer();
		expect(server.send({ type: "press", id: "k1" })).toBe(false);
		expect(await server.request("macros")).toBeUndefined();
	});

	it("reports a port that's already taken", async () => {
		const first = await startServer();
		const status = vi.fn();
		const second = new BridgeServer({ status });
		servers.push(second);
		await second.start(first.port, CODE);
		expect(status).toHaveBeenLastCalledWith({ state: "error", port: first.port, message: `Port ${first.port} is in use` });
	});
});
