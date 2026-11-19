import { readFileSync } from "node:fs";
import path from "node:path";

import { vi } from "vitest";

const en = JSON.parse(readFileSync(path.join(import.meta.dirname, "../module/lang/en.json"), "utf8"));

/** `game.i18n` backed by the module's real English strings. */
function localize(key: string): string {
	const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
	return typeof value === "string" ? value : key;
}

type Doc = { id: string; name: string; [key: string]: unknown };

/** A Foundry-like world collection. */
export function collection<T extends Doc>(docs: T[]) {
	return {
		contents: docs,
		get: (id: string) => docs.find((d) => d.id === id),
		getName: (name: string) => docs.find((d) => d.name === name),
	};
}

/** A stand-in for the Foundry globals the module uses, recording every call. */
export function fakeFoundry({ isGM = true } = {}) {
	const created: unknown[] = [];
	const token = {
		document: { name: "Aragorn", hidden: false, texture: { src: "tokens/aragorn.webp" }, getBarAttribute: () => ({ value: 23, max: 60 }) },
		actor: { name: "Aragorn", img: "actors/aragorn.webp", sheet: { rendered: false, render: vi.fn(), close: vi.fn() } },
		center: { x: 500, y: 400 },
	};
	const sound = { id: "s1", name: "Rain", playing: false };
	const playlist = {
		id: "p1",
		name: "Tavern",
		playing: false,
		folder: { name: "Ambience" },
		sounds: collection([sound]),
		playAll: vi.fn(),
		stopAll: vi.fn(),
		playSound: vi.fn(),
		stopSound: vi.fn(),
	};
	const combat = {
		started: true,
		round: 3,
		combatant: { id: "c2" },
		turns: [
			{ id: "c1", visible: true },
			{ id: "c2", visible: true },
			{ id: "c3", visible: false },
		],
		nextTurn: vi.fn(),
		previousTurn: vi.fn(),
		nextRound: vi.fn(),
		previousRound: vi.fn(),
		endCombat: vi.fn(),
		rollAll: vi.fn(),
		rollNPC: vi.fn(),
		startCombat: vi.fn(),
	};
	const scene = {
		id: "sc1",
		name: "Goblin Cave",
		navName: "",
		thumb: "scenes/cave-thumb.webp",
		active: true,
		isView: true,
		folder: undefined,
		environment: { darknessLevel: 1 },
		view: vi.fn(),
		activate: vi.fn(),
		update: vi.fn(),
		sheet: { render: vi.fn() },
	};
	const macro = { id: "m1", name: "Fireball", img: "icons/fire.svg", canExecute: true, visible: true, folder: { name: "Spells" }, execute: vi.fn() };
	const table = { id: "t1", name: "Treasure", img: "icons/chest.svg", folder: undefined, draw: vi.fn() };

	const game = {
		user: { id: "u1", isGM },
		paused: false,
		togglePause: vi.fn(),
		combat: combat as typeof combat | null,
		macros: collection([macro]),
		scenes: { ...collection([scene]), viewed: scene },
		playlists: { ...collection([playlist]), playing: [] as (typeof playlist)[] },
		tables: collection([table]),
		i18n: {
			localize,
			format: (key: string, data: Record<string, unknown>) => localize(key).replace(/\{(\w+)\}/g, (_, k: string) => String(data[k])),
		},
	};
	const canvas = { ready: true, tokens: { controlled: [token] }, animatePan: vi.fn(), scene };
	const ui = { sidebar: { expand: vi.fn(), changeTab: vi.fn(), tabGroups: { primary: "chat" } }, notifications: { warn: vi.fn(), info: vi.fn() } };
	const ChatMessage = {
		getSpeaker: () => ({ alias: "GM" }),
		getWhisperRecipients: () => [{ id: "gm1" }],
		implementation: { create: vi.fn(async (data: unknown) => created.push(data)) },
	};
	class Roll {
		total = 17;
		constructor(readonly formula: string) {}
		async evaluate() {
			return this;
		}
		toMessage = vi.fn();
	}
	const hooks: string[] = [];
	Object.assign(globalThis, {
		game,
		canvas,
		ui,
		ChatMessage,
		Roll,
		CONFIG: { sounds: { dice: "dice.wav" } },
		Hooks: { on: (name: string) => hooks.push(name) },
	});
	return { game, canvas, ui, ChatMessage, token, sound, playlist, combat, scene, macro, table, created, hooks };
}
