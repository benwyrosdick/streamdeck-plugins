import { describe, expect, it, vi } from "vitest";

// The SDK connects to Stream Deck on use; stub the pieces the actions touch.
vi.mock("@elgato/streamdeck", () => ({
	default: { logger: { error: vi.fn() }, ui: { sendToPropertyInspector: vi.fn(async () => {}) } },
	action: () => (target: unknown) => target,
	SingletonAction: class {
		get actions() {
			return [];
		}
	},
}));

import streamDeck from "@elgato/streamdeck";

import { Cpu } from "../src/actions/cpu";
import { Disk } from "../src/actions/disk";
import { Gpu } from "../src/actions/gpu";
import { Network } from "../src/actions/network";
import { Overview } from "../src/actions/overview";
import type { SystemMonitor } from "../src/monitor";
import type { View } from "../src/render";
import { DISPLAY_DEFAULTS } from "../src/views";

const drives = [
	{ path: "C:\\", label: "C:" },
	{ path: "D:\\", label: "Games" },
];

function fakeMonitor() {
	return {
		subscribe: vi.fn(),
		systemDrive: "C:\\",
		cpu: vi.fn(() => ({ usage: 75, maxCore: 100, cores: 8 })),
		gpu: vi.fn(() => null),
		memory: vi.fn(() => undefined),
		network: vi.fn(() => ({ down: 1024, up: 2048 })),
		disk: vi.fn((path?: string) => ({ ...(drives.find((d) => d.path === (path || "C:\\")) ?? drives[0]), used: 50, free: 50, total: 100 })),
		drives: vi.fn(() => drives),
		history: vi.fn(() => []),
		refresh: vi.fn(async () => {}),
		refreshDrives: vi.fn(async () => drives),
	} as unknown as SystemMonitor;
}

// Expose the protected hooks for testing.
type Hooks<T> = {
	view(settings: T): View;
	press(action: unknown, settings: T): Promise<void>;
	render(action: unknown): Promise<void>;
	onWillAppear(ev: unknown): Promise<void>;
	onSendToPlugin(ev: unknown): Promise<void>;
};

function hooks<T>(instance: object): Hooks<T> {
	const action = instance as unknown as Hooks<T>;
	action.render = async () => {};
	return action;
}

const fakeKey = (settings: object = {}) => ({
	id: "k",
	isKey: () => true,
	isDial: () => false,
	showAlert: vi.fn(async () => {}),
	setSettings: vi.fn(async () => {}),
	settings,
});

describe("metric actions", () => {
	it("render through the monitor with the key's settings", () => {
		const monitor = fakeMonitor();
		expect(hooks(new Cpu(monitor)).view({ style: "ring", warnAt: "70" })).toMatchObject({ style: "ring", value: "75%", level: "warning" });
		expect(hooks(new Gpu(monitor)).view({})).toMatchObject({ value: "N/A" });
	});

	it("refresh on press", async () => {
		const monitor = fakeMonitor();
		await hooks(new Cpu(monitor)).press(fakeKey(), {});
		expect(monitor.refresh).toHaveBeenCalledWith("cpu");
	});

	it("fill in and persist missing default settings on first appearance", async () => {
		const key = fakeKey();
		await hooks(new Cpu(fakeMonitor())).onWillAppear({ action: key, payload: { settings: { style: "neon" } } });
		expect(key.setSettings).toHaveBeenCalledWith({ ...DISPLAY_DEFAULTS, style: "neon" });

		const configured = fakeKey();
		await hooks(new Cpu(fakeMonitor())).onWillAppear({ action: configured, payload: { settings: { ...DISPLAY_DEFAULTS } } });
		expect(configured.setSettings).not.toHaveBeenCalled();
	});
});

describe("Disk", () => {
	it("shows the system drive by default and cycles drives on press", async () => {
		const monitor = fakeMonitor();
		const disk = hooks(new Disk(monitor));
		expect(disk.view({ drive: "" })).toMatchObject({ title: "C:" });

		const key = fakeKey();
		await disk.press(key, { drive: "" });
		expect(key.setSettings).toHaveBeenCalledWith({ drive: "D:\\" });
		expect(monitor.refresh).toHaveBeenCalledWith("disk", "D:\\");

		await disk.press(key, { drive: "D:\\" });
		expect(key.setSettings).toHaveBeenLastCalledWith({ drive: "" });
	});

	it("alerts when there's only one drive", async () => {
		const monitor = fakeMonitor();
		vi.mocked(monitor.refreshDrives).mockResolvedValue([drives[0]]);
		const key = fakeKey();
		await hooks(new Disk(monitor)).press(key, {});
		expect(key.showAlert).toHaveBeenCalled();
		expect(key.setSettings).not.toHaveBeenCalled();
	});

	it("lists drives for the inspector", async () => {
		await hooks(new Disk(fakeMonitor())).onSendToPlugin({ action: fakeKey(), payload: { event: "getDrives" } });
		expect(streamDeck.ui.sendToPropertyInspector).toHaveBeenCalledWith({
			event: "getDrives",
			items: [
				{ label: "System drive", value: "" },
				{ label: "C:", value: "C:\\" },
				{ label: "Games (D:\\)", value: "D:\\" },
			],
		});
	});
});

describe("Network", () => {
	it("switches direction on press", async () => {
		const network = hooks(new Network(fakeMonitor()));
		const key = fakeKey();
		await network.press(key, { style: "bars" });
		expect(key.setSettings).toHaveBeenCalledWith({ style: "bars", direction: "up" });
		await network.press(key, { direction: "up" });
		expect(key.setSettings).toHaveBeenLastCalledWith({ direction: "down" });
		expect(network.view({ direction: "up" })).toMatchObject({ title: "NET ↑", value: "2.0 KB/s" });
	});
});

describe("Overview", () => {
	it("only reads the metrics it shows, and refreshes them on press", async () => {
		const monitor = fakeMonitor();
		const overview = hooks(new Overview(monitor));
		const view = overview.view({ metrics: ["cpu", "network"] });
		expect(view).toMatchObject({ kind: "overview", rows: [{ label: "CPU" }, { label: "NET" }] });
		expect(monitor.gpu).not.toHaveBeenCalled();
		expect(monitor.disk).not.toHaveBeenCalled();

		await overview.press(fakeKey(), { metrics: ["cpu", "network"] });
		expect(vi.mocked(monitor.refresh).mock.calls).toEqual([["cpu"], ["network"]]);
	});
});
