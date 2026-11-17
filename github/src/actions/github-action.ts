import streamDeck, {
	type Action,
	type DialDownEvent,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { GitHubStore } from "../github/store";
import { COLORS, formatCountdown, keyImage, type View } from "../render";

/** Services shared by every action. */
export type GitHub = {
	store: GitHubStore;
	/** Opens `url` in the default browser. */
	openUrl: (url: string) => Promise<void>;
};

/**
 * Shared rendering and press plumbing for every GitHub action.
 *
 * Subclasses describe what a key should look like for its settings
 * ({@link GitHubAction.view}, reading through the shared, cached store) and
 * what pressing it does ({@link GitHubAction.press}). Keys re-render on every
 * store tick and whenever a fetch completes, and only push a new image when
 * what is visible has actually changed.
 */
export abstract class GitHubAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	/** Last-known settings per action instance, so rendering never round-trips to Stream Deck. */
	readonly #settings = new Map<string, T>();
	/** Last rendered view per action instance. */
	readonly #rendered = new Map<string, string>();

	constructor(protected readonly github: GitHub) {
		super();
		github.store.subscribe(() => this.renderAll());
	}

	/** What the key should look like. Must not block: read through the store. */
	protected abstract view(settings: T): View;

	/** Handle a key press, dial press, or touch-strip tap. */
	protected abstract press(action: Action<T>, settings: T): Promise<void>;

	// ------------------------------------------------------------------ //
	// Stream Deck events
	// ------------------------------------------------------------------ //
	override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		this.#rendered.delete(ev.action.id);
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

	// ------------------------------------------------------------------ //
	// Helpers
	// ------------------------------------------------------------------ //
	protected settingsFor(action: Action<T>): T {
		return this.#settings.get(action.id) ?? ({} as T);
	}

	/** Open `url`, re-rendering first so an invalidated value shows as loading. */
	protected async open(action: Action<T>, url: string): Promise<void> {
		await this.render(action);
		try {
			await this.github.openUrl(url);
		} catch (error) {
			streamDeck.logger.error("Failed to open URL", error);
			await showAlert(action);
		}
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

/** The shared "rate limited" key: red, no icon, and a countdown to when polling resumes. */
export function rateLimitedView(until: number, now = Date.now()): View {
	return { background: COLORS.rateLimited, top: "rate limit", bottom: formatCountdown(until - now), bottomSmall: true };
}

/**
 * The key while a count isn't available yet: "auth" (flagged) when `gh` isn't
 * signed in, otherwise a loading ellipsis. Checking auth only here means a
 * flaky auth check can't hide a count that has already been fetched.
 */
export function pendingView(base: View, authenticated: boolean | undefined): View {
	return authenticated === false ? { ...base, bottom: "auth", bottomSmall: true, error: true } : { ...base, bottom: "…" };
}

/** A fetched count, highlighted when there's something to look at. */
export function countView(base: View, count: number): View {
	return { ...base, bottom: String(count), background: count > 0 ? COLORS.highlight : undefined };
}

/** Show the transient warning indicator on keys and dials alike. */
export async function showAlert(action: Action<JsonObject>): Promise<void> {
	if (action.isKey() || action.isDial()) {
		await action.showAlert();
	}
}
