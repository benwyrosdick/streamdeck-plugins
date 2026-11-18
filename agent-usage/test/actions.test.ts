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

import { ClaudeUsage, CopilotUsage } from "../src/actions/agent-key";
import { Overview } from "../src/actions/overview";
import type { ProviderId } from "../src/providers/types";
import type { View } from "../src/render";
import type { ProviderState, UsageStore } from "../src/store";
import { AGENT_DEFAULTS } from "../src/views";

const claudeState: ProviderState = {
	snapshot: {
		windows: [
			{ id: "session", label: "5h", usedPercent: 42 },
			{ id: "weekly", label: "Week", usedPercent: 78 },
		],
	},
};

function fakeStore(states: Partial<Record<ProviderId, ProviderState>> = { claude: claudeState }) {
	return {
		subscribe: vi.fn(),
		state: vi.fn((id: ProviderId) => states[id] ?? {}),
		history: vi.fn(() => [42]),
		refresh: vi.fn(async () => {}),
	} as unknown as UsageStore;
}

type Hooks<T> = {
	view(settings: T): View;
	press(action: unknown, settings: T): Promise<void>;
	render(action: unknown): Promise<void>;
	onWillAppear(ev: unknown): Promise<void>;
};

function hooks<T>(instance: object): Hooks<T> {
	const action = instance as unknown as Hooks<T>;
	action.render = async () => {};
	return action;
}

const key = () => ({ id: "k", isKey: () => true, isDial: () => false, showAlert: vi.fn(async () => {}), setSettings: vi.fn(async () => {}) });

describe("agent keys", () => {
	it("render their provider's state with the window's history", () => {
		const store = fakeStore();
		expect(hooks(new ClaudeUsage(store)).view({ window: "weekly" })).toMatchObject({ title: "Claude Week", value: "78%" });
		expect(store.history).toHaveBeenCalledWith("claude", "weekly");
	});

	it("step to the next window on press, wrapping, and refresh", async () => {
		const store = fakeStore();
		const claude = hooks(new ClaudeUsage(store));
		const k = key();
		await claude.press(k, { window: "" });
		expect(k.setSettings).toHaveBeenLastCalledWith({ window: "weekly" });
		await claude.press(k, { window: "weekly" });
		expect(k.setSettings).toHaveBeenLastCalledWith({ window: "session" });
		expect(store.refresh).toHaveBeenCalledWith("claude");
	});

	it("just refresh when there's only one window", async () => {
		const store = fakeStore({ copilot: { snapshot: { windows: [{ id: "premium", label: "Premium", usedPercent: 1 }] } } });
		const k = key();
		await hooks(new CopilotUsage(store)).press(k, {});
		expect(k.setSettings).not.toHaveBeenCalled();
		expect(store.refresh).toHaveBeenCalledWith("copilot");
	});

	it("save their default settings on first appearance", async () => {
		const k = key();
		await hooks(new ClaudeUsage(fakeStore())).onWillAppear({ action: k, payload: { settings: { style: "bars" } } });
		expect(k.setSettings).toHaveBeenCalledWith({ ...AGENT_DEFAULTS, style: "bars" });
	});
});

describe("Overview", () => {
	it("reads only the chosen agents and refreshes them on press", async () => {
		const store = fakeStore();
		const overview = hooks(new Overview(store));
		expect(overview.view({ agents: ["claude"] })).toEqual({ kind: "overview", rows: [{ label: "Claude", value: "78%", fraction: 0.78, level: "warning" }] });
		expect(store.state).not.toHaveBeenCalledWith("codex");
		await overview.press(key(), { agents: ["claude", "codex"] });
		expect(vi.mocked(store.refresh).mock.calls).toEqual([["claude"], ["codex"]]);
	});
});
