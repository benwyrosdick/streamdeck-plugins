import streamDeck, {
	type Action,
	action,
	type DialDownEvent,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import type { ActionKind, ListItem } from "../bridge/protocol";
import type { Deck } from "../deck";
import { keyImage } from "../render";

/** An item in an sdpi-components `datasource` list (optionally a group of items). */
export type DataSourceItem = { label: string; value?: string; disabled?: boolean; children?: DataSourceItem[] };

/** Inspector list events, and what to ask Foundry for. `settings` lets a list depend on another choice. */
const LISTS: Record<string, (settings: JsonObject) => string | undefined> = {
	getMacros: () => "macros",
	getScenes: () => "scenes",
	getPlaylists: () => "playlists",
	getSounds: (settings) => (typeof settings.playlist === "string" && settings.playlist ? `sounds:${settings.playlist}` : undefined),
	getTables: () => "tables",
};

/**
 * One kind of Foundry key. Foundry does the work and decides what the key
 * shows; this side keeps the deck's key list in sync, relays presses, renders
 * the views Foundry sends, and fills the inspector's lists from the world.
 */
export abstract class FoundryAction extends SingletonAction<JsonObject> {
	protected abstract readonly kind: ActionKind;
	/** Last rendered view per key, to skip redundant redraws. */
	readonly #rendered = new Map<string, string>();

	constructor(protected readonly deck: Deck) {
		super();
		deck.subscribe((ids) => this.renderSome(ids));
		deck.onPress((id, ok) => {
			if (!ok) {
				void this.#alert(id);
			}
		});
	}

	// ------------------------------------------------------------------ //
	// Stream Deck events
	// ------------------------------------------------------------------ //
	override async onWillAppear(ev: WillAppearEvent<JsonObject>): Promise<void> {
		this.#rendered.delete(ev.action.id);
		this.deck.upsert({ id: ev.action.id, action: this.kind, settings: ev.payload.settings });
		await this.render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		this.#rendered.delete(ev.action.id);
		this.deck.remove(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): Promise<void> {
		this.deck.upsert({ id: ev.action.id, action: this.kind, settings: ev.payload.settings });
		await this.render(ev.action);
	}

	override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		await this.press(ev.action);
	}

	override async onDialDown(ev: DialDownEvent<JsonObject>): Promise<void> {
		await this.press(ev.action);
	}

	override async onTouchTap(ev: TouchTapEvent<JsonObject>): Promise<void> {
		await this.press(ev.action);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		const event = isDataSourceRequest(ev.payload) ? ev.payload.event : undefined;
		if (!event || !LISTS[event]) {
			return;
		}
		const what = LISTS[event](await ev.action.getSettings());
		const items = what ? await this.deck.request(what) : [];
		await streamDeck.ui.sendToPropertyInspector({ event, items: toDataSource(items, !!what) } as unknown as JsonValue);
	}

	// ------------------------------------------------------------------ //
	// Helpers
	// ------------------------------------------------------------------ //
	protected async press(action: Action<JsonObject>): Promise<void> {
		if (!this.deck.press(action.id)) {
			// Foundry isn't connected: nothing can happen.
			await showAlert(action);
		}
	}

	protected renderSome(ids: string[]): void {
		const wanted = new Set(ids);
		for (const action of this.actions) {
			if (wanted.has(action.id)) {
				void this.render(action);
			}
		}
	}

	protected async render(action: Action<JsonObject>): Promise<void> {
		const view = this.deck.view(action.id);
		const signature = JSON.stringify(view);
		if (this.#rendered.get(action.id) === signature) {
			return;
		}
		this.#rendered.set(action.id, signature);
		try {
			const image = keyImage(this.kind, view);
			if (action.isKey()) {
				await action.setImage(image);
			} else if (action.isDial()) {
				await action.setFeedback({ icon: image });
			}
		} catch (error) {
			this.#rendered.delete(action.id);
			streamDeck.logger.error("Failed to render key", error);
		}
	}

	async #alert(id: string): Promise<void> {
		const action = this.actions.find((a) => a.id === id);
		if (action) {
			await showAlert(action);
		}
	}
}

/**
 * Foundry's list as sdpi-components datasource items, grouped by folder. When
 * Foundry isn't connected (`undefined`) the list says so instead of being empty.
 */
export function toDataSource(items: ListItem[] | undefined, asked = true): DataSourceItem[] {
	if (!asked) {
		return [{ label: "Choose a playlist first", value: "", disabled: true }];
	}
	if (!items) {
		return [{ label: "Connect Foundry to list these", value: "", disabled: true }];
	}
	if (!items.length) {
		return [{ label: "None in this world", value: "", disabled: true }];
	}
	const loose: DataSourceItem[] = [];
	const groups = new Map<string, DataSourceItem[]>();
	for (const item of items) {
		const entry = { label: String(item.name), value: String(item.id) };
		if (item.group) {
			groups.set(item.group, [...(groups.get(item.group) ?? []), entry]);
		} else {
			loose.push(entry);
		}
	}
	return [...loose, ...[...groups].map(([label, children]) => ({ label, children }))];
}

/** Show the transient warning indicator on keys and dials alike. */
export async function showAlert(action: Action<JsonObject>): Promise<void> {
	if (action.isKey() || action.isDial()) {
		await action.showAlert();
	}
}

function isDataSourceRequest(payload: JsonValue): payload is { event: string } {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload) && typeof payload.event === "string";
}

// ---------------------------------------------------------------------- //
// The actions
// ---------------------------------------------------------------------- //

@action({ UUID: "com.benwyrosdick.foundry-vtt.macro" })
export class MacroAction extends FoundryAction {
	protected override readonly kind = "macro";
}

@action({ UUID: "com.benwyrosdick.foundry-vtt.scene" })
export class SceneAction extends FoundryAction {
	protected override readonly kind = "scene";
}

@action({ UUID: "com.benwyrosdick.foundry-vtt.token" })
export class TokenAction extends FoundryAction {
	protected override readonly kind = "token";
}

@action({ UUID: "com.benwyrosdick.foundry-vtt.combat" })
export class CombatAction extends FoundryAction {
	protected override readonly kind = "combat";
}

@action({ UUID: "com.benwyrosdick.foundry-vtt.playlist" })
export class PlaylistAction extends FoundryAction {
	protected override readonly kind = "playlist";
}

@action({ UUID: "com.benwyrosdick.foundry-vtt.system" })
export class SystemAction extends FoundryAction {
	protected override readonly kind = "system";
}
