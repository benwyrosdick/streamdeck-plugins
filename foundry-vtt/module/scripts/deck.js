import { ACTIONS, HOOKS, UserError, list } from "./actions.js";
import { Thumbnails } from "./images.js";

/** Wait this long after a change for more before re-rendering keys. */
const RENDER_DELAY_MS = 100;

/**
 * The Foundry side of the deck: the keys the plugin told us about, what each
 * shows (re-rendered after relevant Foundry hooks, sending only what
 * changed), and what pressing them does.
 */
export class Deck {
	/** @param {{ send(message: object): boolean }} bridge */
	constructor(bridge) {
		this.bridge = bridge;
		/** id → { id, action, settings } */
		this.keys = new Map();
		/** id → JSON of the view last sent */
		this.sent = new Map();
		this.timer = null;
		this.thumbnails = new Thumbnails(() => this.schedule());
	}

	/** Re-render on every hook that can change a key. */
	listen() {
		for (const hook of HOOKS) Hooks.on(hook, () => this.schedule());
	}

	/** A message from the plugin. */
	receive(message) {
		switch (message.type) {
			case "keys":
				this.keys = new Map((message.keys ?? []).map((key) => [key.id, key]));
				this.sent.clear();
				return this.schedule();
			case "key":
				this.keys.set(message.key.id, message.key);
				this.sent.delete(message.key.id);
				return this.schedule();
			case "keyGone":
				this.keys.delete(message.id);
				this.sent.delete(message.id);
				return;
			case "press":
				return this.press(message.id);
			case "request":
				return this.bridge.send({ type: "response", id: message.id, items: safeList(message.what) });
		}
	}

	/** Forget what was sent (a new connection must be sent every view). */
	reset() {
		this.sent.clear();
	}

	schedule() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.render(), RENDER_DELAY_MS);
	}

	/** Work out every key's view and send the ones that changed. */
	render() {
		const views = {};
		for (const key of this.keys.values()) {
			const view = this.view(key);
			const json = JSON.stringify(view);
			if (this.sent.get(key.id) !== json) {
				views[key.id] = view;
				this.sent.set(key.id, json);
			}
		}
		if (Object.keys(views).length && !this.bridge.send({ type: "views", views })) {
			// Not delivered: send again on the next connection.
			this.sent.clear();
		}
	}

	view(key) {
		const action = ACTIONS[key.action];
		if (!action) return { glyph: "unknown" };
		try {
			const { imageSrc, ...view } = action.view(key.settings ?? {});
			const image = this.thumbnails.get(imageSrc);
			return image ? { ...view, image } : view;
		} catch (error) {
			console.warn("Stream Deck Bridge | couldn't draw a key", error);
			return { glyph: "unknown", title: "Error", border: "alert" };
		}
	}

	async press(id) {
		const key = this.keys.get(id);
		const action = key && ACTIONS[key.action];
		try {
			if (!action) throw new UserError("Unknown key");
			await action.press(key.settings ?? {});
			this.bridge.send({ type: "pressed", id, ok: true });
		} catch (error) {
			const message = error instanceof UserError ? error.message : String(error?.message ?? error);
			if (error instanceof UserError) ui.notifications?.warn(message);
			else console.error("Stream Deck Bridge | press failed", error);
			this.bridge.send({ type: "pressed", id, ok: false, message });
		}
		this.schedule();
	}
}

function safeList(what) {
	try {
		return list(String(what ?? ""));
	} catch (error) {
		console.warn("Stream Deck Bridge | couldn't list", what, error);
		return [];
	}
}
