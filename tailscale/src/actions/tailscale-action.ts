import streamDeck, {
	type Action,
	type DialDownEvent,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { keyImage, type View } from "../render";
import type { TailscaleCli } from "../tailscale/cli";
import type { Profile, TailscaleStatus } from "../tailscale/status";
import type { StatusStore } from "../tailscale/status-store";

/** Services shared by every action. */
export type Tailscale = {
	cli: TailscaleCli;
	status: StatusStore;
};

/** An option in an sdpi-components `datasource` list. */
export type DataSourceItem = {
	label: string;
	value: string;
	disabled?: boolean;
};

/** Longest label shown on a key before it is truncated. */
const MAX_LABEL = 12;

/**
 * Shared rendering, mutation, and property-inspector plumbing for every
 * Tailscale action.
 *
 * Subclasses describe what a key should look like for a given status
 * ({@link TailscaleAction.view}) and what pressing it does
 * ({@link TailscaleAction.press}). Keys re-render whenever the shared status
 * store completes a fetch, and only push a new image when what is visible has
 * actually changed.
 */
export abstract class TailscaleAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	/** Last-known settings per action instance, so polling never round-trips to Stream Deck. */
	readonly #settings = new Map<string, T>();
	/** Last rendered view per action instance. */
	readonly #rendered = new Map<string, string>();

	constructor(protected readonly tailscale: Tailscale) {
		super();
		tailscale.status.subscribe((status) => this.renderAll(status));
	}

	/** What the key should look like. `status` is `undefined` when Tailscale is unavailable. */
	protected abstract view(status: TailscaleStatus | undefined, settings: T): View;

	/** Handle a key press, dial press, or touch-strip tap. */
	protected abstract press(action: Action<T>, settings: T): Promise<void>;

	/**
	 * Adjust settings that just arrived from the property inspector. Return the
	 * settings to persist, or `undefined` to keep them as they are.
	 */
	protected reconcileSettings(_previous: T | undefined, _next: T): Promise<T | undefined> | T | undefined {
		return undefined;
	}

	/**
	 * Prepare settings for display when the property inspector opens. Return
	 * the settings to persist, or `undefined` to keep them as they are.
	 */
	protected settingsForInspector(_settings: T): Promise<T | undefined> | T | undefined {
		return undefined;
	}

	/** Items for an sdpi-components `datasource`, or `undefined` if `event` is unknown. */
	protected dataSource(_event: string, _settings: T): Promise<DataSourceItem[] | undefined> | undefined {
		return undefined;
	}

	// ------------------------------------------------------------------ //
	// Stream Deck events
	// ------------------------------------------------------------------ //
	override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#rendered.delete(ev.action.id);
		await this.render(ev.action, await this.tailscale.status.get());
	}

	override onWillDisappear(ev: WillDisappearEvent<T>): void {
		this.#settings.delete(ev.action.id);
		this.#rendered.delete(ev.action.id);
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

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
		const previous = this.#settings.get(ev.action.id);
		const reconciled = await this.reconcileSettings(previous, structuredClone(ev.payload.settings));
		await this.saveSettings(ev.action, reconciled ?? ev.payload.settings, reconciled !== undefined);
	}

	override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<T>): Promise<void> {
		// The inspector can be opened for a key that isn't on the visible page.
		if (!this.#settings.has(ev.action.id)) {
			this.#settings.set(ev.action.id, await ev.action.getSettings());
		}
		const settings = await this.settingsForInspector(structuredClone(this.settingsFor(ev.action)));
		if (settings !== undefined) {
			await this.saveSettings(ev.action, settings, true);
		}
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

	/** Cache (and optionally persist) settings, then re-render the key. */
	protected async saveSettings(action: Action<T>, settings: T, persist: boolean): Promise<void> {
		this.#settings.set(action.id, settings);
		if (persist) {
			await action.setSettings(settings);
		}
		await this.render(action, this.tailscale.status.current);
	}

	/**
	 * Run a mutating CLI command, then force a fresh status read so every key
	 * reflects the new state immediately. A failure shows the alert indicator.
	 */
	protected async mutate(action: Action<T>, command: () => Promise<boolean>): Promise<void> {
		let ok = false;
		try {
			ok = await command();
		} catch (error) {
			streamDeck.logger.error("Tailscale command threw", error);
		}
		await this.tailscale.status.get({ force: true });
		if (!ok) {
			await showAlert(action);
		}
	}

	protected renderAll(status: TailscaleStatus | undefined): void {
		for (const action of this.actions) {
			void this.render(action, status);
		}
	}

	protected async render(action: Action<T>, status: TailscaleStatus | undefined): Promise<void> {
		const view = this.view(status, this.settingsFor(action));
		const signature = JSON.stringify(view);
		if (this.#rendered.get(action.id) === signature) {
			return;
		}
		this.#rendered.set(action.id, signature);

		try {
			const image = keyImage(view);
			if (action.isKey()) {
				await action.setImage(image);
				if (view.label !== undefined) {
					await action.setTitle(view.label);
				}
			} else if (action.isDial()) {
				await action.setFeedback({ icon: image, value: view.label ?? "" });
			}
		} catch (error) {
			// Let the next status update retry.
			this.#rendered.delete(action.id);
			streamDeck.logger.error("Failed to render key", error);
		}
	}
}

/**
 * The accounts from `tailscale switch --list` as `getProfiles` datasource
 * items, or a disabled hint when they can't be listed. `first` items (e.g. a
 * "last used" choice) go ahead of the accounts.
 */
export async function profileItems(cli: Pick<TailscaleCli, "listProfiles">, first: DataSourceItem[] = []): Promise<DataSourceItem[]> {
	const profiles = await cli.listProfiles();
	if (!profiles) {
		// The hint can't share a value with a real choice, or the picker would select it.
		const value = first.length ? "unavailable" : "";
		return [...first, { value, label: streamDeck.i18n.translate("SwitchAccount.Unavailable"), disabled: true }];
	}
	return [...first, ...profiles.map((p) => ({ value: p.id, label: profileLabel(p) }))];
}

/**
 * How an account reads in a picker: its tailnet and the sign-in, since one
 * sign-in can belong to several tailnets ("VESYL (me@vesyl.com)",
 * "VESYL CloudPrint (me@vesyl.com)"). A personal tailnet named after the
 * account is shown once.
 */
export function profileLabel(profile: Profile): string {
	const { tailnet, account, id, nickname } = profile;
	// A nickname you chose (`tailscale login --nickname`) beats the tailnet name.
	const name = nickname && nickname !== account ? nickname : tailnet;
	if (name && account && name !== account) return `${name} (${account})`;
	return account || name || id;
}

/** Maps a profile id to its tailnet: the name `tailscale status` reports while that account is active. */
export function tailnetLookup(profiles: Profile[] | undefined): (id: string | undefined) => string | undefined {
	return (id) => {
		const profile = profiles?.find((p) => p.id === id);
		return profile ? profile.tailnet || profile.account || undefined : undefined;
	};
}

/** Shorten a label so it fits on a key. */
export function truncate(value: string | undefined, max = MAX_LABEL): string {
	return (value ?? "").slice(0, max);
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
