/**
 * The JSON-over-WebSocket protocol between this plugin (the server, on
 * 127.0.0.1) and the Stream Deck Bridge Foundry module (the client, in the
 * GM's browser). The module's side lives in `module/scripts/bridge.js`.
 *
 * Pairing, before anything else is exchanged (both sides prove they know the
 * code; the code itself never crosses the wire):
 *
 *     plugin → { type: "challenge", nonce }
 *     module → { type: "hello", auth: HMAC(code, "client:" + nonce), cnonce, world, user, isGM, … }
 *     plugin → { type: "welcome", proof: HMAC(code, "server:" + cnonce) }   or   { type: "rejected", reason } + close
 *
 * Then:
 *
 *     plugin → keys {keys}        every key on the deck (sent on connect)
 *     plugin → key {key}          a key appeared or its settings changed
 *     plugin → keyGone {id}       a key disappeared
 *     plugin → press {id}         a key / dial was pressed
 *     plugin → request {id, what} the inspector wants a list (macros, scenes, …)
 *     plugin → replaced           another Foundry window took over; don't reconnect
 *     module → views {views}      what keys should show, by key id (only changed keys)
 *     module → response {id, items}
 *     module → pressed {id, ok, message?}
 *
 * The pairing scheme follows VTT Deck (github.com/zedoc84/vtt-deck, MIT).
 */

export const PROTOCOL = 1;
export const DEFAULT_PORT = 3010;

/** The Stream Deck actions; the module implements one handler per kind. */
export const ACTION_KINDS = ["macro", "scene", "token", "combat", "playlist", "system"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** A key as the module sees it. */
export type KeyInfo = {
	id: string;
	action: ActionKind;
	settings: Record<string, unknown>;
};

/** Glyphs the plugin draws itself; the module picks one when there's no image. */
export const GLYPHS = [
	"macro",
	"scene",
	"token",
	"combat",
	"next",
	"previous",
	"nextRound",
	"previousRound",
	"start",
	"end",
	"dice",
	"music",
	"sound",
	"stop",
	"pause",
	"play",
	"table",
	"chat",
	"moon",
	"sun",
	"sidebar",
	"unknown",
] as const;
export type Glyph = (typeof GLYPHS)[number];

/** State a key's border can signal. */
export const BORDERS = ["active", "viewed", "current", "selected", "alert"] as const;
export type Border = (typeof BORDERS)[number];

/** What a key shows, as described by the module. Every field is optional. */
export type View = {
	glyph?: Glyph;
	/** A thumbnail as a `data:image/…;base64,` URL, made in the browser. */
	image?: string;
	fit?: "cover" | "contain";
	/** Label along the bottom. */
	title?: string;
	/** Large text in the middle (e.g. "R3"), drawn instead of the glyph. */
	big?: string;
	/** Small line under the big text. */
	subtitle?: string;
	/** A gauge along the bottom, e.g. hit points. */
	bar?: { value: number; max: number };
	border?: Border;
	/** Greyed out: nothing to do right now (e.g. no combat to advance). */
	dim?: boolean;
	/** Short tag in the top-right corner, e.g. "GM". */
	badge?: string;
};

export type PluginMessage =
	| { type: "challenge"; nonce: string; protocol: number }
	| { type: "welcome"; proof: string; protocol: number }
	| { type: "rejected"; reason: RejectReason }
	| { type: "keys"; keys: KeyInfo[] }
	| { type: "key"; key: KeyInfo }
	| { type: "keyGone"; id: string }
	| { type: "press"; id: string }
	| { type: "request"; id: string; what: string }
	| { type: "replaced" };

export type ListItem = { id: string; name: string; group?: string };

export type ModuleMessage =
	| { type: "hello"; auth: string; cnonce: string; protocol?: number; world?: string; user?: string; isGM?: boolean; foundry?: string }
	| { type: "views"; views: Record<string, View> }
	| { type: "response"; id: string; items: ListItem[] }
	| { type: "pressed"; id: string; ok: boolean; message?: string };

/** Why the plugin refused a connection. Only `badCode` blames the code. */
export type RejectReason = "badCode" | "timeout" | "locked" | "busy" | "badMessage";
