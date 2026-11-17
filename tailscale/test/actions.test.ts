import { beforeEach, describe, expect, it, vi } from "vitest";

// The SDK connects to Stream Deck on use; stub the pieces the actions touch.
vi.mock("@elgato/streamdeck", () => ({
	default: { i18n: { translate: (key: string) => key }, logger: { error: vi.fn() }, ui: {} },
	action: () => (target: unknown) => target,
	SingletonAction: class {
		get actions() {
			return [];
		}
	},
}));

import type { Tailscale } from "../src/actions/tailscale-action";
import { DEFAULT_SWATCH, SwitchAccount, type SwitchAccountSettings } from "../src/actions/switch-account";
import { AUTO, AUTO_EXIT_NODE, targetFor, ToggleExitNode, type ToggleExitNodeSettings } from "../src/actions/toggle-exit-node";
import type { Profile, TailscaleStatus } from "../src/tailscale/status";

const profiles: Profile[] = [
	{ id: "a1", tailnet: "alpha.com", account: "me@alpha.com", current: true },
	{ id: "b2", tailnet: "beta.org", account: "me@beta.org", current: false },
];

const status: TailscaleStatus = {
	BackendState: "Running",
	CurrentTailnet: { Name: "alpha.com" },
	Peer: {
		x: { DNSName: "relay.ts.net.", TailscaleIPs: ["100.64.0.9"], ExitNodeOption: true },
	},
};

function fakeTailscale() {
	return {
		cli: { listProfiles: vi.fn(async () => profiles), switch: vi.fn(async () => true) },
		status: { subscribe: vi.fn(), get: vi.fn(async () => status), current: status },
	} as unknown as Tailscale;
}

// Expose the protected hooks for testing.
type Hooks<T> = {
	reconcileSettings(previous: T | undefined, next: T): Promise<T | undefined>;
	settingsForInspector(settings: T): Promise<T | undefined>;
	view(status: TailscaleStatus | undefined, settings: T): unknown;
};

describe("SwitchAccount", () => {
	let action: Hooks<SwitchAccountSettings>;
	beforeEach(() => {
		action = new SwitchAccount(fakeTailscale()) as unknown as Hooks<SwitchAccountSettings>;
	});

	it("stores a picked color against the account's tailnet", async () => {
		const previous = { profileA: "a1", colorA: DEFAULT_SWATCH };
		const next = await action.reconcileSettings(previous, { ...previous, colorA: "#FF0000" });
		expect(next?.accountColors).toEqual({ "alpha.com": "#ff0000" });
	});

	it("shows the saved color when an account is picked", async () => {
		const previous = { profileA: "a1", colorA: "#ff0000", accountColors: { "alpha.com": "#ff0000", "beta.org": "#0000ff" } };
		const next = await action.reconcileSettings(previous, { ...previous, profileA: "b2" });
		expect(next?.colorA).toBe("#0000ff");
		expect(next?.accountColors).toEqual(previous.accountColors);
	});

	it("shows the default swatch for accounts without a color", async () => {
		const previous = { profileA: "a1", colorA: "#ff0000", accountColors: { "alpha.com": "#ff0000" } };
		const next = await action.reconcileSettings(previous, { ...previous, profileA: "b2" });
		expect(next?.colorA).toBe(DEFAULT_SWATCH);
		expect(next?.accountColors).toEqual({ "alpha.com": "#ff0000" });
	});

	it("leaves unrelated changes alone", async () => {
		const previous = { profileA: "a1", colorA: "#ff0000", accountColors: { "alpha.com": "#ff0000" } };
		expect(await action.reconcileSettings(previous, { ...previous })).toBeUndefined();
	});

	it("syncs color pickers when the inspector opens", async () => {
		const settings = await action.settingsForInspector({ profileA: "a1", profileB: "b2", accountColors: { "beta.org": "#00ff00" } });
		expect(settings).toMatchObject({ colorA: DEFAULT_SWATCH, colorB: "#00ff00" });
	});

	it("tints the key with the active account's color", () => {
		expect(action.view(status, { accountColors: { "alpha.com": "#123456" } })).toEqual({
			icon: "account",
			background: "#123456",
			label: "alpha.com",
		});
	});
});

describe("ToggleExitNode", () => {
	let action: Hooks<ToggleExitNodeSettings>;
	beforeEach(() => {
		action = new ToggleExitNode(fakeTailscale()) as unknown as Hooks<ToggleExitNodeSettings>;
	});

	it("remembers the pick for the current network", async () => {
		const next = await action.reconcileSettings({ exitNode: AUTO }, { exitNode: "100.64.0.9" });
		expect(next?.nodesByNetwork).toEqual({ "alpha.com": { value: "100.64.0.9", label: "relay" } });
	});

	it("shows the current network's pick when the inspector opens", async () => {
		expect(await action.settingsForInspector({ exitNode: "x", nodesByNetwork: {} })).toEqual({ exitNode: AUTO, nodesByNetwork: {} });
		const settings = { exitNode: AUTO, nodesByNetwork: { "alpha.com": { value: "100.64.0.9", label: "relay" } } };
		expect(await action.settingsForInspector(settings)).toMatchObject({ exitNode: "100.64.0.9" });
	});

	it("targets the saved node only while it is available", () => {
		const saved = { nodesByNetwork: { "alpha.com": { value: "100.64.0.9", label: "relay" } } };
		expect(targetFor(status, saved)).toBe("100.64.0.9");
		expect(targetFor({ ...status, Peer: {} }, saved)).toBe(AUTO_EXIT_NODE);
		expect(targetFor(status, {})).toBe(AUTO_EXIT_NODE);
	});
});
