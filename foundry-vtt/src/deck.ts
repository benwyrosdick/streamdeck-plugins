import type { ActionKind, Glyph, KeyInfo, ListItem, View } from "./bridge/protocol";
import type { BridgeServer } from "./bridge/server";
import { sanitizeView } from "./render";

/** The glyph a key shows while Foundry isn't there to describe it. */
export const KIND_GLYPHS: Record<ActionKind, Glyph> = {
	macro: "macro",
	scene: "scene",
	token: "token",
	combat: "combat",
	playlist: "music",
	system: "sidebar",
};

/** The subset of {@link BridgeServer} the deck uses; swapped out in tests. */
export type Bridge = Pick<BridgeServer, "send" | "request" | "connected">;

/**
 * Every Foundry key on the Stream Deck, shared by all the actions.
 *
 * Keys register here as they appear; the deck keeps Foundry told about them
 * (the full list on connect, then each change), relays presses, and caches
 * the views Foundry sends back so actions can render without waiting.
 */
export class Deck {
	readonly #keys = new Map<string, KeyInfo>();
	readonly #views = new Map<string, View>();
	readonly #listeners = new Set<(ids: string[]) => void>();
	readonly #pressListeners = new Set<(id: string, ok: boolean, message?: string) => void>();
	#bridge: Bridge | undefined;

	attach(bridge: Bridge): void {
		this.#bridge = bridge;
	}

	get connected(): boolean {
		return this.#bridge?.connected ?? false;
	}

	/** A key appeared, or its settings changed. */
	upsert(key: KeyInfo): void {
		this.#keys.set(key.id, key);
		this.#bridge?.send({ type: "key", key });
	}

	remove(id: string): void {
		this.#keys.delete(id);
		this.#views.delete(id);
		this.#bridge?.send({ type: "keyGone", id });
	}

	/** Relay a press; false when Foundry isn't connected to handle it. */
	press(id: string): boolean {
		return this.#bridge?.send({ type: "press", id }) ?? false;
	}

	request(what: string): Promise<ListItem[] | undefined> {
		return this.#bridge?.request(what) ?? Promise.resolve(undefined);
	}

	/** What key `id` should show right now. */
	view(id: string): View {
		const kind = this.#keys.get(id)?.action ?? "system";
		if (!this.connected) {
			return { glyph: KIND_GLYPHS[kind], title: "Offline", dim: true };
		}
		return this.#views.get(id) ?? { glyph: KIND_GLYPHS[kind], title: "…" };
	}

	// ------------------------------------------------------------------ //
	// Bridge events
	// ------------------------------------------------------------------ //
	onConnected(): void {
		this.#bridge?.send({ type: "keys", keys: [...this.#keys.values()] });
		this.#changed([...this.#keys.keys()]);
	}

	onDisconnected(): void {
		this.#views.clear();
		this.#changed([...this.#keys.keys()]);
	}

	onViews(views: Record<string, unknown>): void {
		const ids = Object.keys(views).filter((id) => this.#keys.has(id));
		for (const id of ids) {
			this.#views.set(id, sanitizeView(views[id]));
		}
		this.#changed(ids);
	}

	onPressed(id: string, ok: boolean, message?: string): void {
		for (const listener of this.#pressListeners) {
			listener(id, ok, message);
		}
	}

	// ------------------------------------------------------------------ //
	// Subscriptions
	// ------------------------------------------------------------------ //
	/** Called with the ids of keys whose view changed. */
	subscribe(listener: (ids: string[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Called when Foundry reports how a press went. */
	onPress(listener: (id: string, ok: boolean, message?: string) => void): () => void {
		this.#pressListeners.add(listener);
		return () => this.#pressListeners.delete(listener);
	}

	#changed(ids: string[]): void {
		if (!ids.length) return;
		for (const listener of this.#listeners) {
			listener(ids);
		}
	}
}
