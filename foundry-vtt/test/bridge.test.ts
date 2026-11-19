import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { Bridge } from "../module/scripts/bridge.js";
import { BridgeServer, type BridgeEvents } from "../src/bridge/server";

const CODE = "K7QM-3XWD";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0)) await fn();
});

const until = async (check: () => boolean, ms = 3_000) => {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

async function server(events: Partial<BridgeEvents> = {}) {
	const s = new BridgeServer(events, { authTimeoutMs: 500 });
	await s.start(0, CODE);
	cleanup.push(() => s.stop());
	return s;
}

/** The Foundry module's Bridge, talking over `ws` instead of a browser WebSocket. */
function moduleBridge(port: number, code: string) {
	const states: string[] = [];
	const messages: { type: string }[] = [];
	const bridge = new Bridge({
		config: () => ({ host: "127.0.0.1", port, code }),
		hello: () => ({ world: "Lost Mine", user: "Gamemaster", isGM: true, foundry: "13.351" }),
		onMessage: (m: object) => void messages.push(m as { type: string }),
		onState: (s: string) => states.push(s),
		WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
	});
	cleanup.push(() => bridge.stop());
	bridge.start();
	return { bridge, states, messages };
}

describe("module ↔ plugin bridge", () => {
	it("pairs with the plugin and exchanges messages both ways", async () => {
		const views = vi.fn();
		const connected = vi.fn();
		const s = await server({ views, connected });
		const m = moduleBridge(s.port, "k7qm 3xwd");
		await until(() => m.bridge.connected && s.connected);
		expect(m.states).toEqual(["connected"]);
		expect(connected).toHaveBeenCalled();
		expect(s.status).toMatchObject({ state: "connected", client: { world: "Lost Mine", user: "Gamemaster", isGM: true } });

		s.send({ type: "press", id: "key-1" });
		await until(() => m.messages.length > 0);
		expect(m.messages[0]).toEqual({ type: "press", id: "key-1" });

		m.bridge.send({ type: "views", views: { "key-1": { title: "Fireball" } } });
		await until(() => views.mock.calls.length > 0);
		expect(views).toHaveBeenCalledWith({ "key-1": { title: "Fireball" } });
	});

	it("stops retrying after the plugin rejects the code", async () => {
		const s = await server();
		const m = moduleBridge(s.port, "WRONGCODE");
		await until(() => m.states.includes("badCode"));
		expect(m.bridge.connected).toBe(false);
		expect(m.bridge.stopped).toBe(true);
	});

	it("doesn't trust a server that can't prove it knows the code", async () => {
		// An impostor on the port: sends a challenge, then a made-up proof, then tries to press a key.
		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		cleanup.push(() => new Promise((resolve) => wss.close(resolve)));
		wss.on("connection", (socket) => {
			socket.send(JSON.stringify({ type: "challenge", nonce: "abc" }));
			socket.once("message", () => {
				socket.send(JSON.stringify({ type: "welcome", proof: "0".repeat(64) }));
				socket.send(JSON.stringify({ type: "press", id: "key-1" }));
			});
		});
		await new Promise((resolve) => wss.once("listening", resolve));
		const m = moduleBridge((wss.address() as { port: number }).port, CODE);
		await until(() => m.states.includes("badProof"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(m.messages).toEqual([]);
		expect(m.bridge.connected).toBe(false);
	});

	it("waits for a code before connecting", () => {
		const m = moduleBridge(1, "");
		expect(m.states).toEqual(["noCode"]);
		expect(m.bridge.socket).toBeNull();
	});

	it("steps aside when another window takes over", async () => {
		const s = await server();
		const first = moduleBridge(s.port, CODE);
		await until(() => first.bridge.connected);
		const second = moduleBridge(s.port, CODE);
		await until(() => second.bridge.connected && first.states.includes("replaced"));
		expect(first.bridge.stopped).toBe(true);
		expect(s.connected).toBe(true);
	});

	it("reconnects after the plugin restarts", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const s = await server();
			const m = moduleBridge(s.port, CODE);
			await vi.waitFor(() => expect(m.bridge.connected).toBe(true));
			const port = s.port;
			await s.stop();
			await vi.waitFor(() => expect(m.bridge.connected).toBe(false));
			await s.start(port, CODE);
			await vi.advanceTimersByTimeAsync(2_000);
			await vi.waitFor(() => expect(m.bridge.connected).toBe(true));
		} finally {
			vi.useRealTimers();
		}
	});
});
