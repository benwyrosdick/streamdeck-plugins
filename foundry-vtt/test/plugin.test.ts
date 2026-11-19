import { describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({
	default: { logger: { error: vi.fn() }, ui: { sendToPropertyInspector: vi.fn(async () => {}) } },
	action: () => (target: unknown) => target,
	SingletonAction: class {
		get actions() {
			return [];
		}
	},
}));

import streamDeck from "@elgato/streamdeck";

import { MacroAction, PlaylistAction, toDataSource } from "../src/actions/foundry-action";
import type { PluginMessage } from "../src/bridge/protocol";
import { Deck } from "../src/deck";
import { escapeXml, keySvg, sanitizeView } from "../src/render";
import { statusText } from "../src/status";

function fakeBridge(connected = true) {
	const sent: PluginMessage[] = [];
	return {
		sent,
		connected,
		send: (m: PluginMessage) => (connected ? (sent.push(m), true) : false),
		request: vi.fn(async (what: string) => (connected ? [{ id: "1", name: what }] : undefined)),
	};
}

describe("Deck", () => {
	it("keeps Foundry told about keys, and sends them all on connect", () => {
		const bridge = fakeBridge();
		const deck = new Deck();
		deck.attach(bridge);
		deck.upsert({ id: "k1", action: "macro", settings: { macro: "m1" } });
		deck.upsert({ id: "k2", action: "scene", settings: {} });
		deck.remove("k2");
		deck.onConnected();
		expect(bridge.sent).toEqual([
			{ type: "key", key: { id: "k1", action: "macro", settings: { macro: "m1" } } },
			{ type: "key", key: { id: "k2", action: "scene", settings: {} } },
			{ type: "keyGone", id: "k2" },
			{ type: "keys", keys: [{ id: "k1", action: "macro", settings: { macro: "m1" } }] },
		]);
	});

	it("shows keys as offline, loading, then as Foundry describes them", () => {
		const deck = new Deck();
		const bridge = fakeBridge(false);
		deck.attach(bridge);
		deck.upsert({ id: "k1", action: "combat", settings: {} });
		expect(deck.view("k1")).toEqual({ glyph: "combat", title: "Offline", dim: true });
		bridge.connected = true;
		expect(deck.view("k1")).toEqual({ glyph: "combat", title: "…" });
		const changed = vi.fn();
		deck.subscribe(changed);
		deck.onViews({ k1: { big: "R2", subtitle: "Turn 1/4" }, unknown: { title: "ignored" } });
		expect(changed).toHaveBeenCalledWith(["k1"]);
		expect(deck.view("k1")).toEqual({ big: "R2", subtitle: "Turn 1/4" });
		deck.onDisconnected();
		bridge.connected = false;
		expect(deck.view("k1").title).toBe("Offline");
	});

	it("only relays presses when Foundry is there", () => {
		const deck = new Deck();
		deck.attach(fakeBridge(false));
		expect(deck.press("k1")).toBe(false);
	});
});

describe("actions", () => {
	const key = (settings: Record<string, unknown> = {}) => ({
		id: "k1",
		isKey: () => true,
		isDial: () => false,
		showAlert: vi.fn(async () => {}),
		setImage: vi.fn(async () => {}),
		getSettings: vi.fn(async () => settings),
	});
	type Hooks = {
		onWillAppear(ev: unknown): Promise<void>;
		onKeyDown(ev: unknown): Promise<void>;
		onSendToPlugin(ev: unknown): Promise<void>;
	};

	it("register their key with the deck and draw it", async () => {
		const deck = new Deck();
		const bridge = fakeBridge();
		deck.attach(bridge);
		const k = key();
		await (new MacroAction(deck) as unknown as Hooks).onWillAppear({ action: k, payload: { settings: { macro: "m1" } } });
		expect(bridge.sent).toEqual([{ type: "key", key: { id: "k1", action: "macro", settings: { macro: "m1" } } }]);
		expect(k.setImage).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/svg\+xml;base64,/));
	});

	it("press through to Foundry, or alert when it isn't connected", async () => {
		const deck = new Deck();
		const bridge = fakeBridge();
		deck.attach(bridge);
		await (new MacroAction(deck) as unknown as Hooks).onKeyDown({ action: key() });
		expect(bridge.sent).toEqual([{ type: "press", id: "k1" }]);

		const offline = new Deck();
		offline.attach(fakeBridge(false));
		const k = key();
		await (new MacroAction(offline) as unknown as Hooks).onKeyDown({ action: k });
		expect(k.showAlert).toHaveBeenCalled();
	});

	it("fill inspector lists from Foundry, including a playlist's sounds", async () => {
		const deck = new Deck();
		const bridge = fakeBridge();
		deck.attach(bridge);
		const action = new PlaylistAction(deck) as unknown as Hooks;
		await action.onSendToPlugin({ action: key({ playlist: "p1" }), payload: { event: "getSounds" } });
		expect(bridge.request).toHaveBeenCalledWith("sounds:p1");
		expect(streamDeck.ui.sendToPropertyInspector).toHaveBeenLastCalledWith({ event: "getSounds", items: [{ label: "sounds:p1", value: "1" }] });
		await action.onSendToPlugin({ action: key({}), payload: { event: "getSounds" } });
		expect(streamDeck.ui.sendToPropertyInspector).toHaveBeenLastCalledWith({
			event: "getSounds",
			items: [{ label: "Choose a playlist first", value: "", disabled: true }],
		});
	});

	it("group list items by folder, and explain empty or missing lists", () => {
		expect(
			toDataSource([
				{ id: "a", name: "Loose" },
				{ id: "b", name: "Fireball", group: "Spells" },
				{ id: "c", name: "Heal", group: "Spells" },
			]),
		).toEqual([
			{ label: "Loose", value: "a" },
			{ label: "Spells", children: [{ label: "Fireball", value: "b" }, { label: "Heal", value: "c" }] },
		]);
		expect(toDataSource(undefined)[0].label).toBe("Connect Foundry to list these");
		expect(toDataSource([])[0].label).toBe("None in this world");
	});
});

describe("render", () => {
	const png = "data:image/png;base64,iVBORw0KGgo=";

	it("keeps only safe parts of a view from Foundry", () => {
		expect(
			sanitizeView({
				glyph: "macro",
				image: png,
				title: `  ${"x".repeat(60)}  `,
				badge: "GMGMGM",
				border: "active",
				dim: true,
				bar: { value: 5, max: 10 },
				extra: "dropped",
			}),
		).toEqual({ glyph: "macro", image: png, title: "x".repeat(40), badge: "GMGM", border: "active", dim: true, bar: { value: 5, max: 10 } });
		expect(sanitizeView({ glyph: "evil", image: "javascript:alert(1)", border: "pink", bar: { value: 1, max: 0 } })).toEqual({});
		expect(sanitizeView({ image: 'data:image/png;base64,AAA"/><script>' })).toEqual({});
		expect(sanitizeView(null)).toEqual({});
	});

	it("draws images, text, borders and dimming", () => {
		const svg = keySvg("scene", { image: png, title: "Goblin Cave", border: "active", dim: true });
		expect(svg).toContain(`href="${png}"`);
		expect(svg).toContain(">Goblin Cave</text>");
		expect(svg).toContain("#3fbf5f");
		expect(svg).toContain('fill-opacity="0.55"');
		expect(keySvg("combat", { big: "R3", subtitle: "Turn 2/5" })).toContain(">R3</text>");
		expect(keySvg("macro", { title: "<b>" })).toContain(">&#60;b&#62;</text>");
		expect(escapeXml(`"'`)).toBe("&#34;&#39;");
	});
});

describe("statusText", () => {
	it("reads well in every state", () => {
		expect(statusText({ state: "listening", port: 3010 })).toBe("Waiting for Foundry on port 3010");
		expect(statusText({ state: "listening", port: 3010, rejected: "badCode" })).toBe("Rejected a Foundry window with the wrong pairing code (port 3010)");
		expect(statusText({ state: "connected", port: 3010, client: { world: "Lost Mine", user: "Gamemaster", isGM: true } })).toBe(
			"Connected to Lost Mine as Gamemaster (GM)",
		);
		expect(statusText({ state: "error", port: 3010, message: "Port 3010 is in use" })).toBe("Not listening: Port 3010 is in use");
	});
});
