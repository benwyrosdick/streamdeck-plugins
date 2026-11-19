/**
 * What each kind of key shows and does in Foundry (v13 / v14).
 *
 * `view(settings)` returns what the key should show (see the plugin's
 * src/bridge/protocol.ts `View`), plus an optional `imageSrc` path that the
 * deck turns into a thumbnail. `press(settings)` does the work, throwing a
 * {@link UserError} for problems the user should be told about.
 *
 * The Foundry API usage follows VTT Deck (github.com/zedoc84/vtt-deck, MIT).
 */
import { t } from "./i18n.js";

/** A problem to show the user as a warning, not a stack trace. */
export class UserError extends Error {}

const fail = (key, data) => {
	throw new UserError(t(key, data));
};
const requireGM = () => {
	if (!game.user.isGM) fail("Errors.GMOnly");
};
const canvasReady = () => !!globalThis.canvas?.ready;
const selectedToken = () => (canvasReady() ? (canvas.tokens.controlled[0] ?? null) : null);

/** A document by id, with a name fallback for keys copied between worlds. */
const byId = (collection, id) => (id ? (collection.get(id) ?? null) : null);

function panTo(token) {
	if (!token || !canvasReady()) return;
	canvas.animatePan({ ...token.center, duration: 250 });
}

function toggleSheet(actor) {
	const sheet = actor?.sheet;
	if (!sheet) return;
	if (sheet.rendered) sheet.close();
	else sheet.render(true);
}

/** Recipients for a GM-only whisper. */
const gmIds = () => ChatMessage.getWhisperRecipients("GM").map((user) => user.id);

/** Plain text from a Stream Deck setting; a shared profile mustn't be able to post HTML. */
export const escapeText = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------------- //
// Macro
// ---------------------------------------------------------------------- //

const macro = {
	view(s) {
		const doc = byId(game.macros, s.macro);
		if (!doc) return { glyph: "macro", title: t(s.macro ? "Keys.Missing" : "Keys.ChooseMacro"), dim: true };
		return { imageSrc: doc.img, fit: "contain", glyph: "macro", title: doc.name };
	},
	async press(s) {
		const doc = byId(game.macros, s.macro);
		if (!doc) fail("Errors.MacroMissing");
		if (doc.canExecute === false) fail("Errors.MacroNoPermission", { name: doc.name });
		await doc.execute();
	},
};

// ---------------------------------------------------------------------- //
// Scene
// ---------------------------------------------------------------------- //

const scene = {
	view(s) {
		const doc = byId(game.scenes, s.scene);
		if (!doc) return { glyph: "scene", title: t(s.scene ? "Keys.Missing" : "Keys.ChooseScene"), dim: true };
		return {
			imageSrc: doc.thumb || doc.background?.src || null,
			glyph: "scene",
			title: doc.navName || doc.name,
			// Green: shown to the players. Blue: only you are looking at it.
			border: doc.active ? "active" : doc.isView ? "viewed" : undefined,
		};
	},
	async press(s) {
		const doc = byId(game.scenes, s.scene);
		if (!doc) fail("Errors.SceneMissing");
		switch (s.onPress ?? "view") {
			case "activate":
				requireGM();
				return doc.activate();
			case "configure":
				return doc.sheet.render(true);
			default:
				return doc.view();
		}
	},
};

// ---------------------------------------------------------------------- //
// Token: the selected token
// ---------------------------------------------------------------------- //

/** Bar 1 (usually hit points) as `{value, max}`, whatever the game system calls it. */
function barOne(token) {
	const bar = token.document.getBarAttribute?.("bar1");
	return bar && typeof bar.value === "number" && typeof bar.max === "number" && bar.max > 0 ? { value: bar.value, max: bar.max } : undefined;
}

const token = {
	view(s) {
		const selected = selectedToken();
		if (!selected) return { glyph: "token", title: t("Keys.NoToken"), dim: true };
		const doc = selected.document;
		const show = s.show ?? "name";
		const name = doc.name ?? selected.actor?.name ?? "?";
		const bar = show === "nameBar" || show === "bar" ? barOne(selected) : undefined;
		return {
			imageSrc: doc.texture?.src || selected.actor?.img || null,
			glyph: "token",
			title: show === "name" || show === "nameBar" ? name : undefined,
			bar,
			dim: !!doc.hidden,
		};
	},
	async press(s) {
		const selected = selectedToken();
		if (!selected) fail("Errors.NoToken");
		switch (s.onPress ?? "pan") {
			case "sheet":
				if (!selected.actor) fail("Errors.NoActor");
				return toggleSheet(selected.actor);
			default:
				return panTo(selected);
		}
	},
};

// ---------------------------------------------------------------------- //
// Combat
// ---------------------------------------------------------------------- //

const COMBAT = {
	next: { glyph: "next", key: "Keys.NextTurn", needs: "started" },
	previous: { glyph: "previous", key: "Keys.PreviousTurn", needs: "started", gm: true },
	nextRound: { glyph: "nextRound", key: "Keys.NextRound", needs: "started", gm: true },
	previousRound: { glyph: "previousRound", key: "Keys.PreviousRound", needs: "started", gm: true },
	start: { glyph: "start", key: "Keys.StartCombat", gm: true },
	end: { glyph: "end", key: "Keys.EndCombat", needs: "started", gm: true },
	rollAll: { glyph: "dice", key: "Keys.RollAll", needs: "combat", gm: true },
	rollNPC: { glyph: "dice", key: "Keys.RollNPC", needs: "combat", gm: true },
};

/** Combatants this user can see, in initiative order. */
const visibleTurns = (combat) => (combat?.turns ?? []).filter((c) => game.user.isGM || c.visible);

const combat = {
	view(s) {
		const current = game.combat;
		const fn = s.fn ?? "next";
		if (fn === "status") {
			if (!current) return { big: "—", subtitle: t("Keys.NoCombat"), dim: true };
			if (!current.started) return { big: "R0", subtitle: t("Keys.NotStarted") };
			const turns = visibleTurns(current);
			const turn = turns.findIndex((c) => c.id === current.combatant?.id) + 1;
			return { big: `R${current.round}`, subtitle: t("Keys.TurnOf", { n: turn || "?", total: turns.length }) };
		}
		const def = COMBAT[fn] ?? COMBAT.next;
		const dim = def.needs === "started" ? !current?.started : def.needs === "combat" ? !current : fn === "start" && !!current?.started;
		return { glyph: def.glyph, title: t(def.key), dim };
	},
	async press(s) {
		const fn = s.fn ?? "next";
		let current = game.combat;
		if (fn === "status") {
			ui.sidebar?.expand?.();
			return ui.sidebar?.changeTab?.("combat", "primary");
		}
		const def = COMBAT[fn];
		if (!def) fail("Errors.Unknown");
		if (def.gm) requireGM();
		if (fn === "start") {
			if (!current) {
				// No encounter yet: make one from the selected tokens.
				const docs = canvasReady() ? canvas.tokens.controlled.map((tk) => tk.document) : [];
				if (!docs.length) fail("Errors.NoCombatNoSelection");
				await docs[0].constructor.createCombatants(docs);
				current = game.combat;
			}
			return current?.startCombat();
		}
		if (!current) fail("Errors.NoCombat");
		const calls = {
			next: () => current.nextTurn(),
			previous: () => current.previousTurn(),
			nextRound: () => current.nextRound(),
			previousRound: () => current.previousRound(),
			end: () => current.endCombat(),
			rollAll: () => current.rollAll(),
			rollNPC: () => current.rollNPC(),
		};
		return calls[fn]();
	},
};

// ---------------------------------------------------------------------- //
// Playlists and sounds
// ---------------------------------------------------------------------- //

const playlist = {
	view(s) {
		const mode = s.mode ?? "playlist";
		if (mode === "stopAll") {
			return { glyph: "stop", title: t("Keys.StopAll"), dim: !(game.playlists.playing?.length > 0) };
		}
		const list = byId(game.playlists, s.playlist);
		if (!list) return { glyph: "music", title: t(s.playlist ? "Keys.Missing" : "Keys.ChoosePlaylist"), dim: true };
		if (mode === "sound") {
			const sound = byId(list.sounds, s.sound);
			if (!sound) return { glyph: "sound", title: t(s.sound ? "Keys.Missing" : "Keys.ChooseSound"), dim: true };
			return { glyph: "sound", title: sound.name, border: sound.playing ? "active" : undefined };
		}
		return { glyph: "music", title: list.name, border: list.playing ? "active" : undefined, badge: list.playing ? "▶" : undefined };
	},
	async press(s) {
		const mode = s.mode ?? "playlist";
		if (mode === "stopAll") {
			for (const list of game.playlists.playing ?? []) await list.stopAll();
			return;
		}
		const list = byId(game.playlists, s.playlist);
		if (!list) fail("Errors.PlaylistMissing");
		if (mode === "sound") {
			const sound = byId(list.sounds, s.sound);
			if (!sound) fail("Errors.SoundMissing");
			return sound.playing ? list.stopSound(sound) : list.playSound(sound);
		}
		return list.playing ? list.stopAll() : list.playAll();
	},
};

// ---------------------------------------------------------------------- //
// System: pause, dice, tables, chat, darkness, sidebar
// ---------------------------------------------------------------------- //

const SIDEBAR_TABS = ["chat", "combat", "scenes", "actors", "items", "journal", "tables", "cards", "macros", "playlists", "compendium", "settings"];

function activeSidebarTab() {
	return ui.sidebar?.tabGroups?.primary ?? ui.sidebar?.activeTab ?? null;
}

/** 0–100 from a setting, as a 0–1 darkness level. */
const darknessOf = (s) => Math.max(0, Math.min(100, Number(s.darkness ?? 100))) / 100;

function currentScene() {
	return canvasReady() ? canvas.scene : game.scenes.viewed;
}

const system = {
	view(s) {
		switch (s.fn ?? "pause") {
			case "pause":
				return game.paused
					? { glyph: "play", title: t("Keys.Resume"), border: "alert" }
					: { glyph: "pause", title: t("Keys.Pause") };
			case "roll":
				return {
					glyph: "dice",
					title: s.label || s.formula || t("Keys.ChooseFormula"),
					dim: !s.formula,
					badge: s.rollMode === "gm" ? "GM" : s.rollMode === "self" ? "Me" : undefined,
				};
			case "table": {
				const table = byId(game.tables, s.table);
				if (!table) return { glyph: "table", title: t(s.table ? "Keys.Missing" : "Keys.ChooseTable"), dim: true };
				return { imageSrc: table.img, fit: "contain", glyph: "table", title: table.name };
			}
			case "chat":
				return { glyph: "chat", title: s.message || t("Keys.ChooseMessage"), dim: !s.message, badge: s.whisperGM ? "GM" : undefined };
			case "darkness": {
				const target = darknessOf(s);
				const now = currentScene()?.environment?.darknessLevel;
				return {
					glyph: target >= 0.5 ? "moon" : "sun",
					title: `${Math.round(target * 100)}%`,
					border: typeof now === "number" && Math.abs(now - target) < 0.01 ? "current" : undefined,
				};
			}
			case "sidebar": {
				const tab = SIDEBAR_TABS.includes(s.tab) ? s.tab : "chat";
				return { glyph: "sidebar", title: t(`Tabs.${tab}`), border: activeSidebarTab() === tab ? "selected" : undefined };
			}
		}
		return { glyph: "unknown" };
	},
	async press(s) {
		switch (s.fn ?? "pause") {
			case "pause":
				requireGM();
				return game.togglePause(!game.paused, { broadcast: true });
			case "roll": {
				if (!s.formula) fail("Keys.ChooseFormula");
				const roll = await new Roll(String(s.formula)).evaluate();
				const speaker = ChatMessage.getSpeaker();
				const flavor = s.label ? escapeText(s.label) : undefined;
				const mode = s.rollMode ?? "current";
				if (mode === "current") return roll.toMessage({ speaker, flavor });
				return ChatMessage.implementation.create({
					speaker,
					flavor,
					rolls: [roll],
					content: String(roll.total),
					sound: CONFIG.sounds.dice,
					whisper: mode === "gm" ? gmIds() : mode === "self" ? [game.user.id] : [],
				});
			}
			case "table": {
				const table = byId(game.tables, s.table);
				if (!table) fail("Errors.TableMissing");
				return table.draw();
			}
			case "chat":
				if (!s.message) fail("Keys.ChooseMessage");
				return ChatMessage.implementation.create({
					speaker: ChatMessage.getSpeaker(),
					content: escapeText(s.message),
					whisper: s.whisperGM ? gmIds() : [],
				});
			case "darkness": {
				requireGM();
				const doc = currentScene();
				if (!doc) fail("Errors.SceneMissing");
				return doc.update({ "environment.darknessLevel": darknessOf(s) }, { animateDarkness: 2500 });
			}
			case "sidebar": {
				const tab = SIDEBAR_TABS.includes(s.tab) ? s.tab : "chat";
				ui.sidebar?.expand?.();
				return ui.sidebar?.changeTab?.(tab, "primary");
			}
		}
		fail("Errors.Unknown");
	},
};

/** Every key kind, by the plugin's action name. */
export const ACTIONS = { macro, scene, token, combat, playlist, system };

/**
 * Foundry hooks after which keys may show something different. One list for
 * all kinds: re-rendering every key is cheap, and only changed views are sent.
 */
export const HOOKS = [
	"createMacro", "updateMacro", "deleteMacro",
	"createScene", "updateScene", "deleteScene", "canvasReady",
	"controlToken", "createToken", "updateToken", "deleteToken", "updateActor",
	"createCombat", "updateCombat", "deleteCombat", "combatStart", "combatTurnChange",
	"createCombatant", "updateCombatant", "deleteCombatant",
	"createPlaylist", "updatePlaylist", "deletePlaylist",
	"createPlaylistSound", "updatePlaylistSound", "deletePlaylistSound",
	"pauseGame", "changeSidebarTab", "collapseSidebar",
	"createRollTable", "updateRollTable", "deleteRollTable",
];

/** Lists for the Stream Deck inspector's dropdowns. */
export function list(what) {
	const byName = (a, b) => a.name.localeCompare(b.name);
	const entries = (docs) => docs.map((d) => ({ id: d.id, name: d.name, group: d.folder?.name })).sort(byName);
	if (what.startsWith("sounds:")) {
		const doc = game.playlists.get(what.slice("sounds:".length));
		return doc ? doc.sounds.contents.map((x) => ({ id: x.id, name: x.name })).sort(byName) : [];
	}
	switch (what) {
		case "macros":
			return entries(game.macros.contents.filter((m) => m.visible ?? true));
		case "scenes":
			return game.scenes.contents.map((d) => ({ id: d.id, name: d.navName || d.name, group: d.folder?.name })).sort(byName);
		case "playlists":
			return entries(game.playlists.contents);
		case "tables":
			return entries(game.tables.contents);
	}
	return [];
}
