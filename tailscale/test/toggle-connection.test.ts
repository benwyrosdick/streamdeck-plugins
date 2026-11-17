import { describe, expect, it, vi } from "vitest";

// The SDK connects to Stream Deck on use; stub the pieces the actions touch.
vi.mock("@elgato/streamdeck", () => ({
	default: { i18n: { translate: (key: string) => key }, logger: { error: vi.fn() }, ui: { sendToPropertyInspector: vi.fn(async () => {}) } },
	action: () => (target: unknown) => target,
	SingletonAction: class {
		get actions() {
			return [];
		}
	},
}));

import streamDeck from "@elgato/streamdeck";

import type { Tailscale } from "../src/actions/tailscale-action";
import { ToggleConnection, type ToggleConnectionSettings } from "../src/actions/toggle-connection";
import type { Profile, TailscaleStatus } from "../src/tailscale/status";

const alpha: Profile = { id: "a1", tailnet: "alpha.com", account: "me@alpha.com", current: true };
const beta: Profile = { id: "b2", tailnet: "beta.org", account: "me@beta.org", current: false };

const on = (tailnet: string): TailscaleStatus => ({ BackendState: "Running", CurrentTailnet: { Name: tailnet } });
const off = (tailnet: string): TailscaleStatus => ({ BackendState: "Stopped", CurrentTailnet: { Name: tailnet } });

/**
 * A fake CLI + status store. `statuses` are served in order by forced reads
 * (the last one repeats), standing in for the daemon settling after a switch.
 */
function fakeTailscale({ initial, after = [], current = "a1" }: { initial: TailscaleStatus; after?: TailscaleStatus[]; current?: string }) {
	const queue = [...after];
	let latest = initial;
	const cli = {
		listProfiles: vi.fn(async () => [alpha, beta].map((p) => ({ ...p, current: p.id === current }))),
		up: vi.fn(async () => true),
		down: vi.fn(async () => true),
		switch: vi.fn(async () => true),
	};
	const status = {
		subscribe: vi.fn(),
		get: vi.fn(async ({ force = false } = {}) => {
			if (force && queue.length) {
				latest = queue.shift() as TailscaleStatus;
			}
			return latest;
		}),
		get current() {
			return latest;
		},
	};
	return { cli, status } as unknown as Tailscale & { cli: typeof cli };
}

type Hooks = {
	view(status: TailscaleStatus | undefined, settings: ToggleConnectionSettings): unknown;
	press(action: unknown, settings: ToggleConnectionSettings): Promise<void>;
	reconcileSettings(previous: ToggleConnectionSettings | undefined, next: ToggleConnectionSettings): Promise<ToggleConnectionSettings | undefined>;
	settingsForInspector(settings: ToggleConnectionSettings): Promise<ToggleConnectionSettings | undefined>;
	onSendToPlugin(ev: unknown): Promise<void>;
};

const hooks = (tailscale: Tailscale) => new ToggleConnection(tailscale) as unknown as Hooks;
const key = () => ({ id: "k", isKey: () => true, isDial: () => false, showAlert: vi.fn(async () => {}) });

const betaKey: ToggleConnectionSettings = { profile: "b2", tailnet: "beta.org" };

describe("ToggleConnection view", () => {
	it("follows whatever account is active when no account is set", () => {
		const action = hooks(fakeTailscale({ initial: on("alpha.com") }));
		expect(action.view(on("alpha.com"), {})).toEqual({ icon: "connected", background: "#00963c", label: "alpha.com" });
		expect(action.view(off("beta.org"), {})).toEqual({ icon: "disconnected", label: "beta.org" });
	});

	it("only lights up while its own tailnet is connected", () => {
		const action = hooks(fakeTailscale({ initial: on("alpha.com") }));
		expect(action.view(on("beta.org"), betaKey)).toEqual({ icon: "connected", background: "#00963c", label: "beta.org" });
		expect(action.view({ BackendState: "Starting", CurrentTailnet: { Name: "beta.org" } }, betaKey)).toMatchObject({ icon: "connecting" });
		// Another tailnet connected (or starting): this key reads as off, still labelled with its own tailnet.
		expect(action.view(on("alpha.com"), betaKey)).toEqual({ icon: "disconnected", label: "beta.org" });
		expect(action.view({ BackendState: "Starting", CurrentTailnet: { Name: "alpha.com" } }, betaKey)).toEqual({ icon: "disconnected", label: "beta.org" });
	});

	it("flags Tailscale being unavailable", () => {
		expect(hooks(fakeTailscale({ initial: on("alpha.com") })).view(undefined, betaKey)).toMatchObject({ error: true });
	});
});

describe("ToggleConnection press", () => {
	it("toggles the last used account when no account is set", async () => {
		const connected = fakeTailscale({ initial: on("alpha.com") });
		await hooks(connected).press(key(), {});
		expect(connected.cli.down).toHaveBeenCalled();
		expect(connected.cli.switch).not.toHaveBeenCalled();

		const disconnected = fakeTailscale({ initial: off("alpha.com") });
		await hooks(disconnected).press(key(), {});
		expect(disconnected.cli.up).toHaveBeenCalled();
	});

	it("disconnects when its own tailnet is connected", async () => {
		const tailscale = fakeTailscale({ initial: on("beta.org"), current: "b2" });
		await hooks(tailscale).press(key(), betaKey);
		expect(tailscale.cli.down).toHaveBeenCalled();
		expect(tailscale.cli.switch).not.toHaveBeenCalled();
	});

	it("switches from another connected tailnet without an extra up when the account resumes running", async () => {
		const tailscale = fakeTailscale({ initial: on("alpha.com"), after: [{ BackendState: "NoState" }, on("beta.org")] });
		await hooks(tailscale).press(key(), betaKey);
		expect(tailscale.cli.switch).toHaveBeenCalledWith("b2");
		expect(tailscale.cli.up).not.toHaveBeenCalled();
		expect(tailscale.cli.down).not.toHaveBeenCalled();
	});

	it("switches and brings the account up when it was left stopped", async () => {
		const tailscale = fakeTailscale({ initial: on("alpha.com"), after: [off("beta.org")] });
		await hooks(tailscale).press(key(), betaKey);
		expect(tailscale.cli.switch).toHaveBeenCalledWith("b2");
		expect(tailscale.cli.up).toHaveBeenCalled();
	});

	it("just connects when its account is active but stopped", async () => {
		const tailscale = fakeTailscale({ initial: off("beta.org"), after: [off("beta.org")], current: "b2" });
		await hooks(tailscale).press(key(), betaKey);
		expect(tailscale.cli.switch).not.toHaveBeenCalled();
		expect(tailscale.cli.up).toHaveBeenCalled();
	});

	it("alerts and stops if the switch fails", async () => {
		const tailscale = fakeTailscale({ initial: on("alpha.com") });
		tailscale.cli.switch.mockResolvedValue(false);
		const k = key();
		await hooks(tailscale).press(k, betaKey);
		expect(tailscale.cli.up).not.toHaveBeenCalled();
		expect(k.showAlert).toHaveBeenCalled();
	});
});

describe("ToggleConnection settings", () => {
	it("stores the picked account's tailnet, and clears it for last used", async () => {
		const action = hooks(fakeTailscale({ initial: on("alpha.com") }));
		expect(await action.reconcileSettings({}, { profile: "b2" })).toEqual(betaKey);
		expect(await action.reconcileSettings(betaKey, { profile: "", tailnet: "beta.org" })).toEqual({ profile: "" });
		expect(await action.reconcileSettings(betaKey, { ...betaKey })).toBeUndefined();
	});

	it("refreshes a stale tailnet when the inspector opens", async () => {
		const action = hooks(fakeTailscale({ initial: on("alpha.com") }));
		expect(await action.settingsForInspector({ profile: "b2", tailnet: "old.org" })).toEqual(betaKey);
		expect(await action.settingsForInspector(betaKey)).toBeUndefined();
	});

	it("offers last used ahead of the accounts", async () => {
		await hooks(fakeTailscale({ initial: on("alpha.com") })).onSendToPlugin({ action: key(), payload: { event: "getProfiles" } });
		expect(streamDeck.ui.sendToPropertyInspector).toHaveBeenCalledWith({
			event: "getProfiles",
			items: [
				{ value: "", label: "ToggleConnection.LastUsed" },
				{ value: "a1", label: "me@alpha.com" },
				{ value: "b2", label: "me@beta.org" },
			],
		});
	});
});
