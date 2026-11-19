import { beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIONS, escapeText, HOOKS, list, UserError } from "../module/scripts/actions.js";
import { Deck } from "../module/scripts/deck.js";
import { fakeFoundry } from "./foundry-fake";

type Settings = Record<string, unknown>;
const view = (kind: keyof typeof ACTIONS, s: Settings = {}) => ACTIONS[kind].view(s) as Record<string, unknown>;
const press = (kind: keyof typeof ACTIONS, s: Settings = {}) => ACTIONS[kind].press(s);

let world: ReturnType<typeof fakeFoundry>;
beforeEach(() => {
	world = fakeFoundry();
});

describe("macro keys", () => {
	it("show the macro and run it", async () => {
		expect(view("macro", { macro: "m1" })).toEqual({ imageSrc: "icons/fire.svg", fit: "contain", glyph: "macro", title: "Fireball" });
		await press("macro", { macro: "m1" });
		expect(world.macro.execute).toHaveBeenCalled();
	});

	it("ask for a macro, and flag one that was deleted", async () => {
		expect(view("macro")).toMatchObject({ title: "Choose macro", dim: true });
		expect(view("macro", { macro: "gone" })).toMatchObject({ title: "Missing", dim: true });
		await expect(press("macro", { macro: "gone" })).rejects.toThrow("That macro no longer exists.");
	});

	it("refuse a macro the user can't run", async () => {
		world.macro.canExecute = false;
		await expect(press("macro", { macro: "m1" })).rejects.toBeInstanceOf(UserError);
		expect(world.macro.execute).not.toHaveBeenCalled();
	});
});

describe("scene keys", () => {
	it("show the thumbnail and whether it's active or viewed", () => {
		expect(view("scene", { scene: "sc1" })).toMatchObject({ imageSrc: "scenes/cave-thumb.webp", title: "Goblin Cave", border: "active" });
		world.scene.active = false;
		expect(view("scene", { scene: "sc1" }).border).toBe("viewed");
	});

	it("view, activate or configure on press; activating is GM-only", async () => {
		await press("scene", { scene: "sc1" });
		expect(world.scene.view).toHaveBeenCalled();
		await press("scene", { scene: "sc1", onPress: "activate" });
		expect(world.scene.activate).toHaveBeenCalled();
		await press("scene", { scene: "sc1", onPress: "configure" });
		expect(world.scene.sheet.render).toHaveBeenCalledWith(true);
		world.game.user.isGM = false;
		await expect(press("scene", { scene: "sc1", onPress: "activate" })).rejects.toThrow("Only the GM can do that.");
	});
});

describe("token keys", () => {
	it("show the selected token with its name and, optionally, bar 1", () => {
		expect(view("token")).toMatchObject({ imageSrc: "tokens/aragorn.webp", title: "Aragorn", bar: undefined });
		expect(view("token", { show: "nameBar" })).toMatchObject({ title: "Aragorn", bar: { value: 23, max: 60 } });
		expect(view("token", { show: "bar" })).toMatchObject({ title: undefined, bar: { value: 23, max: 60 } });
	});

	it("say when nothing is selected", async () => {
		world.canvas.tokens.controlled = [];
		expect(view("token")).toMatchObject({ title: "No token", dim: true });
		await expect(press("token")).rejects.toThrow("Select a token first.");
	});

	it("pan to the token or toggle its sheet", async () => {
		await press("token");
		expect(world.canvas.animatePan).toHaveBeenCalledWith({ x: 500, y: 400, duration: 250 });
		await press("token", { onPress: "sheet" });
		expect(world.token.actor.sheet.render).toHaveBeenCalledWith(true);
	});
});

describe("combat keys", () => {
	it("show the round and the turn among the combatants this user can see", () => {
		// The GM sees the hidden combatant too.
		expect(view("combat", { fn: "status" })).toEqual({ big: "R3", subtitle: "Turn 2/3" });
		world.game.user.isGM = false;
		expect(view("combat", { fn: "status" })).toEqual({ big: "R3", subtitle: "Turn 2/2" });
		world.game.combat = null;
		expect(view("combat", { fn: "status" })).toMatchObject({ big: "—", subtitle: "No combat", dim: true });
	});

	it("dim controls that can't act yet", () => {
		expect(view("combat", { fn: "next" })).toEqual({ glyph: "next", title: "Next turn", dim: false });
		world.combat.started = false;
		expect(view("combat", { fn: "next" }).dim).toBe(true);
		expect(view("combat", { fn: "start" }).dim).toBe(false);
	});

	it("drive the tracker", async () => {
		for (const [fn, method] of [
			["next", "nextTurn"],
			["previous", "previousTurn"],
			["nextRound", "nextRound"],
			["end", "endCombat"],
			["rollNPC", "rollNPC"],
		] as const) {
			await press("combat", { fn });
			expect(world.combat[method]).toHaveBeenCalled();
		}
	});

	it("start a combat from the selected tokens when there is none", async () => {
		const createCombatants = vi.fn(async () => {
			world.game.combat = world.combat;
		});
		world.token.document = Object.assign(Object.create({ constructor: { createCombatants } }), world.token.document);
		world.game.combat = null;
		await press("combat", { fn: "start" });
		expect(createCombatants).toHaveBeenCalledWith([world.token.document]);
		expect(world.combat.startCombat).toHaveBeenCalled();
	});

	it("keep GM-only controls from players, but let them end their own turn", async () => {
		world.game.user.isGM = false;
		await expect(press("combat", { fn: "nextRound" })).rejects.toThrow("Only the GM can do that.");
		await press("combat", { fn: "next" });
		expect(world.combat.nextTurn).toHaveBeenCalled();
	});
});

describe("music keys", () => {
	it("toggle a playlist and show when it's playing", async () => {
		expect(view("playlist", { playlist: "p1" })).toMatchObject({ glyph: "music", title: "Tavern", border: undefined });
		await press("playlist", { playlist: "p1" });
		expect(world.playlist.playAll).toHaveBeenCalled();
		world.playlist.playing = true;
		expect(view("playlist", { playlist: "p1" })).toMatchObject({ border: "active", badge: "▶" });
		await press("playlist", { playlist: "p1" });
		expect(world.playlist.stopAll).toHaveBeenCalled();
	});

	it("toggle a single sound", async () => {
		await press("playlist", { mode: "sound", playlist: "p1", sound: "s1" });
		expect(world.playlist.playSound).toHaveBeenCalledWith(world.sound);
		world.sound.playing = true;
		expect(view("playlist", { mode: "sound", playlist: "p1", sound: "s1" })).toMatchObject({ glyph: "sound", title: "Rain", border: "active" });
	});

	it("stop everything that's playing", async () => {
		expect(view("playlist", { mode: "stopAll" }).dim).toBe(true);
		world.game.playlists.playing = [world.playlist];
		await press("playlist", { mode: "stopAll" });
		expect(world.playlist.stopAll).toHaveBeenCalled();
	});
});

describe("system keys", () => {
	it("pause and resume, highlighting the paused state", async () => {
		expect(view("system", { fn: "pause" })).toEqual({ glyph: "pause", title: "Pause" });
		await press("system", { fn: "pause" });
		expect(world.game.togglePause).toHaveBeenCalledWith(true, { broadcast: true });
		world.game.paused = true;
		expect(view("system", { fn: "pause" })).toMatchObject({ glyph: "play", border: "alert" });
	});

	it("roll dice publicly or as a GM-only whisper", async () => {
		await press("system", { fn: "roll", formula: "1d20+5", rollMode: "gm", label: "Stealth" });
		expect(world.created[0]).toMatchObject({ flavor: "Stealth", content: "17", whisper: ["gm1"] });
		expect(view("system", { fn: "roll", formula: "1d20+5", rollMode: "gm" })).toMatchObject({ title: "1d20+5", badge: "GM" });
	});

	it("posts chat as plain text, never HTML", async () => {
		await press("system", { fn: "chat", message: "<img src=x onerror=alert(1)>" });
		expect(world.created[0]).toMatchObject({ content: "&#60;img src=x onerror=alert(1)&#62;" });
		expect(escapeText(`"'&`)).toBe("&#34;&#39;&#38;");
	});

	it("draw from a table", async () => {
		await press("system", { fn: "table", table: "t1" });
		expect(world.table.draw).toHaveBeenCalled();
	});

	it("set the scene's darkness, marking the level already in effect", async () => {
		expect(view("system", { fn: "darkness", darkness: 100 })).toMatchObject({ glyph: "moon", title: "100%", border: "current" });
		expect(view("system", { fn: "darkness", darkness: 0 })).toMatchObject({ glyph: "sun", border: undefined });
		await press("system", { fn: "darkness", darkness: 30 });
		expect(world.scene.update).toHaveBeenCalledWith({ "environment.darknessLevel": 0.3 }, { animateDarkness: 2500 });
	});

	it("open a sidebar tab", async () => {
		await press("system", { fn: "sidebar", tab: "journal" });
		expect(world.ui.sidebar.changeTab).toHaveBeenCalledWith("journal", "primary");
		expect(view("system", { fn: "sidebar", tab: "chat" })).toMatchObject({ title: "Chat", border: "selected" });
	});
});

describe("lists for the inspector", () => {
	it("list documents with their folders, and a playlist's sounds", () => {
		expect(list("macros")).toEqual([{ id: "m1", name: "Fireball", group: "Spells" }]);
		expect(list("playlists")).toEqual([{ id: "p1", name: "Tavern", group: "Ambience" }]);
		expect(list("sounds:p1")).toEqual([{ id: "s1", name: "Rain" }]);
		expect(list("sounds:nope")).toEqual([]);
		expect(list("bogus")).toEqual([]);
	});
});

describe("Deck", () => {
	const fakeBridge = () => ({ sent: [] as Record<string, unknown>[], send(m: Record<string, unknown>) {
		this.sent.push(m);
		return true;
	} });

	it("sends each key's view once, then only what changed", () => {
		const bridge = fakeBridge();
		const deck = new Deck(bridge);
		deck.receive({ type: "keys", keys: [{ id: "k1", action: "system", settings: { fn: "pause" } }, { id: "k2", action: "macro", settings: { macro: "m1" } }] });
		deck.render();
		expect(bridge.sent).toEqual([{ type: "views", views: { k1: { glyph: "pause", title: "Pause" }, k2: { fit: "contain", glyph: "macro", title: "Fireball" } } }]);
		deck.render();
		expect(bridge.sent).toHaveLength(1);
		world.game.paused = true;
		deck.render();
		expect(bridge.sent[1]).toEqual({ type: "views", views: { k1: { glyph: "play", title: "Resume", border: "alert" } } });
	});

	it("runs presses and reports how they went", async () => {
		const bridge = fakeBridge();
		const deck = new Deck(bridge);
		deck.receive({ type: "keys", keys: [{ id: "k1", action: "macro", settings: { macro: "m1" } }, { id: "k2", action: "macro", settings: { macro: "gone" } }] });
		await deck.press("k1");
		await deck.press("k2");
		expect(bridge.sent).toContainEqual({ type: "pressed", id: "k1", ok: true });
		expect(bridge.sent).toContainEqual({ type: "pressed", id: "k2", ok: false, message: "That macro no longer exists." });
		expect(world.ui.notifications.warn).toHaveBeenCalledWith("That macro no longer exists.");
	});

	it("answers list requests and listens to every relevant hook", () => {
		const bridge = fakeBridge();
		const deck = new Deck(bridge);
		deck.receive({ type: "request", id: "7", what: "tables" });
		expect(bridge.sent).toEqual([{ type: "response", id: "7", items: [{ id: "t1", name: "Treasure", group: undefined }] }]);
		deck.listen();
		expect(world.hooks).toEqual(HOOKS);
	});

	it("resends everything after a failed delivery", () => {
		let up = false;
		const sent: unknown[] = [];
		const deck = new Deck({ send: (m: unknown) => (up ? (sent.push(m), true) : false) });
		deck.receive({ type: "keys", keys: [{ id: "k1", action: "system", settings: { fn: "pause" } }] });
		deck.render();
		up = true;
		deck.render();
		expect(sent).toHaveLength(1);
	});
});
