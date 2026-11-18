import streamDeck, {
	type Action,
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

import { keyImage, type View } from "../render";
import type { UsageStore } from "../store";

/** An option in an sdpi-components `datasource` list. */
export type DataSourceItem = { label: string; value: string };

/**
 * Shared rendering, press and property-inspector plumbing for every key.
 *
 * Subclasses describe what a key should look like for its settings
 * ({@link KeyAction.view}, reading through the shared store, which also
 * tells the store what to poll) and what pressing it does
 * ({@link KeyAction.press}). Keys re-render after every store tick, and only
 * push a new image when what is visible has actually changed.
 */
export abstract class KeyAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	/** Last-known settings per action instance, so rendering never round-trips to Stream Deck. */
	readonly #settings = new Map<string, T>();
	/** Last rendered view per action instance. */
	readonly #rendered = new Map<string, string>();

	constructor(protected readonly store: UsageStore) {
		super();
		store.subscribe(() => this.renderAll());
	}

	/** What the key should look like. Must not block: read through the store. */
	protected abstract view(settings: T): View;

	/** Handle a key press, dial press, or touch-strip tap. */
	protected abstract press(action: Action<T>, settings: T): Promise<void>;

	/**
	 * Settings a new key starts with. They're written back on first
	 * appearance so the property inspector shows what the key is doing.
	 */
	protected defaults(): Partial<T> {
		return {};
	}

	/** Items for an sdpi-components `datasource`, or `undefined` if `event` is unknown. */
	protected dataSource(_event: string, _settings: T): Promise<DataSourceItem[] | undefined> | undefined {
		return undefined;
	}

	// ------------------------------------------------------------------ //
	// Stream Deck events
	// ------------------------------------------------------------------ //
	override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
		const settings = ev.payload.settings;
		const missing = Object.entries(this.defaults()).filter(([key]) => settings[key] === undefined);
		this.#settings.set(ev.action.id, { ...settings, ...Object.fromEntries(missing) });
		this.#rendered.delete(ev.action.id);
		if (missing.length) {
			await ev.action.setSettings(this.settingsFor(ev.action));
		}
		await this.render(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent<T>): void {
		this.#settings.delete(ev.action.id);
		this.#rendered.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		await this.render(ev.action);
	}

	override async onKeyDown(ev: KeyDownEvent<T>): Promise<void> {
		await this.press(ev.action, this.settingsFor(ev.action));
	}

	override async onDialDown(ev: DialDownEvent<T>): Promise<void> {
		await this.press(ev.action, this.settingsFor(ev.action));
	}

	override async onTouchTap(ev: TouchTapEvent<T>): Promise<void> {
		await this.press(ev.action, this.settingsFor(ev.action));
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, T>): Promise<void> {
		const event = isDataSourceRequest(ev.payload) ? ev.payload.event : undefined;
		if (event === undefined) {
			return;
		}
		const items = await this.dataSource(event, this.settingsFor(ev.action));
		if (items !== undefined) {
			await streamDeck.ui.sendToPropertyInspector({ event, items });
		}
	}

	// ------------------------------------------------------------------ //
	// Helpers
	// ------------------------------------------------------------------ //
	protected settingsFor(action: Action<T>): T {
		return this.#settings.get(action.id) ?? ({} as T);
	}

	/** Persist settings changed by a press (e.g. the next window), then re-render. */
	protected async saveSettings(action: Action<T>, settings: T): Promise<void> {
		this.#settings.set(action.id, settings);
		await action.setSettings(settings);
		await this.render(action);
	}

	protected renderAll(): void {
		for (const action of this.actions) {
			void this.render(action);
		}
	}

	protected async render(action: Action<T>): Promise<void> {
		const view = this.view(this.settingsFor(action));
		const signature = JSON.stringify(view);
		if (this.#rendered.get(action.id) === signature) {
			return;
		}
		this.#rendered.set(action.id, signature);

		try {
			const image = keyImage(view);
			if (action.isKey()) {
				await action.setImage(image);
			} else if (action.isDial()) {
				await action.setFeedback({ icon: image });
			}
		} catch (error) {
			// Let the next tick retry.
			this.#rendered.delete(action.id);
			streamDeck.logger.error("Failed to render key", error);
		}
	}
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
