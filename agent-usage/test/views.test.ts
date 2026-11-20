import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/providers/types";
import type { ProviderState } from "../src/store";
import { agentView, formatCountdown, levelFor, overviewAgents, overviewView, overviewWindow, selectWindow, tightestWindow, windowChoices, windowName, windowPace } from "../src/views";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const MIN = 60_000;

const claude: ProviderState = {
	snapshot: {
		plan: "max",
		windows: [
			{ id: "session", label: "5h", usedPercent: 42, resetsAt: NOW + 133 * MIN },
			{ id: "weekly", label: "Week", usedPercent: 78, resetsAt: NOW + 3 * 24 * 60 * MIN + 4 * 60 * MIN },
		],
	},
};

describe("formatCountdown", () => {
	it("is compact at every scale", () => {
		expect(formatCountdown(0)).toBe("now");
		expect(formatCountdown(45 * MIN)).toBe("45m");
		expect(formatCountdown(133 * MIN)).toBe("2h 13m");
		expect(formatCountdown((3 * 24 + 4) * 60 * MIN)).toBe("3d 4h");
		expect(formatCountdown(-5 * MIN)).toBe("now");
	});
});

describe("levelFor", () => {
	it("colours by percent used, honouring custom thresholds and the off switch", () => {
		expect(levelFor(69, {})).toBe("normal");
		expect(levelFor(70, {})).toBe("warning");
		expect(levelFor(90, {})).toBe("critical");
		expect(levelFor(55, { warnAt: "50", critAt: "60" })).toBe("warning");
		expect(levelFor(100, { colorize: false })).toBe("normal");
	});
});

describe("agentView", () => {
	it("shows the first window with its reset countdown by default", () => {
		expect(agentView("claude", claude, [10, 42], {}, NOW)).toEqual({
			kind: "gauge",
			style: "ring",
			level: "normal",
			title: "Claude 5h",
			value: "42%",
			detail: "2h 13m",
			fraction: 0.42,
			history: [0.1, 0.42],
		});
	});

	it("spells out the reset outside the ring, and drops it for usage only", () => {
		expect(agentView("claude", claude, [], { style: "classic" }, NOW).detail).toBe("resets 2h 13m");
		expect(agentView("claude", claude, [], { layout: "single" }, NOW).detail).toBeUndefined();
	});

	it("shows a chosen window, coloured by usage", () => {
		expect(agentView("claude", claude, [], { window: "weekly" }, NOW)).toMatchObject({ title: "Claude Week", value: "78%", level: "warning", detail: "3d 4h" });
	});

	it("can show percent left, still coloured by percent used", () => {
		expect(agentView("claude", claude, [40], { window: "weekly", metric: "remaining" }, NOW)).toMatchObject({
			value: "22% left",
			level: "warning",
			fraction: 0.22,
			history: [0.6],
		});
	});

	it("explains login problems instead of showing a stale reading", () => {
		const expired = { ...claude, error: new ProviderError("expired", "x") };
		expect(agentView("claude", expired, [], {}, NOW)).toMatchObject({ value: "Expired", detail: "run Claude Code", level: "idle", title: "Claude" });
		expect(agentView("copilot", { error: new ProviderError("signedOut", "x") }, [], {}, NOW)).toMatchObject({ value: "Sign in", detail: "gh auth login" });
		expect(agentView("codex", { error: new ProviderError("unsupported", "x") }, [], {}, NOW)).toMatchObject({ value: "N/A" });
	});

	it("keeps showing the last reading through transient failures", () => {
		const offline = { ...claude, error: new ProviderError("failed", "x") };
		expect(agentView("claude", offline, [], {}, NOW)).toMatchObject({ value: "42%" });
		expect(agentView("claude", { error: new ProviderError("failed", "x") }, [], {}, NOW)).toMatchObject({ value: "Error" });
	});

	it("handles loading, missing windows, unlimited quotas and custom labels", () => {
		expect(agentView("codex", {}, [], {}, NOW)).toMatchObject({ value: "…", level: "idle" });
		expect(agentView("claude", claude, [], { window: "opus" }, NOW)).toMatchObject({ value: "N/A", detail: "not on plan" });
		const copilot: ProviderState = { snapshot: { windows: [{ id: "chat", label: "Chat", usedPercent: undefined, resetsAt: NOW + 45 * MIN }] } };
		expect(agentView("copilot", copilot, [], {}, NOW)).toMatchObject({ title: "Copilot Chat", value: "∞", level: "normal" });
		expect(agentView("claude", claude, [], { label: "Work" }, NOW).title).toBe("Work 5h");
	});

	it("carries the window's pace, flipped when showing what's left", () => {
		const HOUR = 60 * MIN;
		// 30% used, 1 of 5 hours gone: ahead of the clock.
		const ahead: ProviderState = { snapshot: { windows: [{ id: "session", label: "5h", usedPercent: 30, resetsAt: NOW + 4 * HOUR, windowMs: 5 * HOUR }] } };
		expect(agentView("claude", ahead, [], {}, NOW).pace).toEqual({ at: 0.2, ahead: true });
		expect(agentView("claude", ahead, [], { metric: "remaining" }, NOW).pace).toEqual({ at: 0.8, ahead: true });
		// 30% used, 4 of 5 hours gone: behind.
		const behind: ProviderState = { snapshot: { windows: [{ id: "session", label: "5h", usedPercent: 30, resetsAt: NOW + HOUR, windowMs: 5 * HOUR }] } };
		expect(agentView("claude", behind, [], {}, NOW).pace).toEqual({ at: 0.8, ahead: false });
		// No window length, no pace.
		expect(agentView("claude", claude, [], {}, NOW)).not.toHaveProperty("pace");
	});

	it("titles Grok's credits by their period", () => {
		const grok: ProviderState = { snapshot: { windows: [{ id: "credits", label: "Week", usedPercent: 1, resetsAt: NOW + 45 * MIN }] } };
		expect(agentView("grok", grok, [], { style: "classic" }, NOW)).toMatchObject({ title: "Grok Week", value: "1%", detail: "resets 45m" });
		expect(agentView("grok", { error: new ProviderError("expired", "x") }, [], {}, NOW)).toMatchObject({ value: "Expired", detail: "run grok" });
	});

	it("titles Copilot's premium requests as just Copilot", () => {
		const copilot: ProviderState = { snapshot: { windows: [{ id: "premium", label: "Premium", usedPercent: 35, remaining: 975 }] } };
		expect(agentView("copilot", copilot, [], {}, NOW)).toMatchObject({ title: "Copilot", value: "35%", detail: "975 left" });
	});
});

describe("windowPace", () => {
	const HOUR = 60 * MIN;
	it("is the fraction of the window that has passed, clamped", () => {
		expect(windowPace({ id: "s", label: "5h", usedPercent: 1, resetsAt: NOW + 4.5 * HOUR, windowMs: 5 * HOUR }, NOW)).toBe(0.1);
		expect(windowPace({ id: "s", label: "5h", usedPercent: 1, resetsAt: NOW - HOUR, windowMs: 5 * HOUR }, NOW)).toBe(1);
		expect(windowPace({ id: "s", label: "5h", usedPercent: 1, resetsAt: NOW + 9 * HOUR, windowMs: 5 * HOUR }, NOW)).toBe(0);
		expect(windowPace({ id: "s", label: "5h", usedPercent: 1, windowMs: 5 * HOUR }, NOW)).toBeUndefined();
	});
});

describe("window choices", () => {
	const fable = { id: "model:fable", label: "Fable", usedPercent: 0 };
	it("lists the windows the account has, naming model limits", () => {
		const windows = [...(claude.snapshot?.windows ?? []), fable];
		expect(windowChoices("claude", windows, "", "First available")).toEqual([
			{ value: "", label: "First available" },
			{ value: "session", label: "5-hour session" },
			{ value: "weekly", label: "Weekly (all models)" },
			{ value: "model:fable", label: "Weekly Fable" },
		]);
	});

	it("falls back to the known windows before the first reading", () => {
		expect(windowChoices("codex", undefined, "", "Most used").map((c) => c.value)).toEqual(["", "session", "weekly"]);
	});

	it("keeps a chosen window that's gone, marked", () => {
		expect(windowChoices("claude", claude.snapshot?.windows, "model:fable", "First available").at(-1)).toEqual({
			value: "model:fable",
			label: "Weekly Fable (not on plan)",
		});
		expect(windowName("claude", fable)).toBe("Weekly Fable");
	});

	it("titles a model limit by the model", () => {
		const withFable: ProviderState = { snapshot: { windows: [...(claude.snapshot?.windows ?? []), { ...fable, resetsAt: NOW + 45 * MIN }] } };
		expect(agentView("claude", withFable, [], { window: "model:fable", style: "classic" }, NOW)).toMatchObject({ title: "Claude Fable", value: "0%", detail: "resets 45m" });
	});
});

describe("window selection", () => {
	it("falls back to the first window and finds the tightest", () => {
		const windows = claude.snapshot?.windows ?? [];
		expect(selectWindow(windows, "")?.id).toBe("session");
		expect(selectWindow(windows, "weekly")?.id).toBe("weekly");
		expect(tightestWindow(windows)?.id).toBe("weekly");
	});
});

describe("overviewView", () => {
	it("shows each chosen agent's tightest limit", () => {
		const view = overviewView(
			{ claude, codex: { error: new ProviderError("expired", "x") }, copilot: {} },
			{ agents: ["copilot", "claude", "codex"] },
		);
		expect(view.rows).toEqual([
			{ label: "Claude", value: "78%", fraction: 0.78, level: "warning" },
			{ label: "Codex", value: "Expired", fraction: 0, level: "idle" },
			{ label: "Copilot", value: "…", fraction: 0, level: "idle" },
		]);
	});

	it("pins Claude and Codex rows to a chosen window, naming it", () => {
		const codex: ProviderState = {
			snapshot: {
				windows: [
					{ id: "session", label: "5h", usedPercent: 91 },
					{ id: "weekly", label: "Week", usedPercent: 12 },
				],
			},
		};
		const view = overviewView({ claude, codex }, { agents: ["claude", "codex"], claudeWindow: "session", codexWindow: "weekly" });
		expect(view.rows).toEqual([
			{ label: "Claude 5h", value: "42%", fraction: 0.42, level: "normal" },
			{ label: "Codex Wk", value: "12%", fraction: 0.12, level: "normal" },
		]);
		// "Most used" stays the default and keeps the plain name.
		expect(overviewView({ codex }, { agents: ["codex"], codexWindow: "" }).rows[0]).toMatchObject({ label: "Codex", value: "91%", level: "critical" });
	});

	it("shows N/A when the pinned window isn't on the plan", () => {
		const sessionOnly: ProviderState = { snapshot: { windows: [{ id: "session", label: "5h", usedPercent: 5 }] } };
		expect(overviewView({ codex: sessionOnly }, { agents: ["codex"], codexWindow: "weekly" }).rows[0]).toEqual({
			label: "Codex",
			value: "N/A",
			fraction: 0,
			level: "normal",
		});
	});

	it("ignores a pinned window for agents that can't pin one", () => {
		const copilot: ProviderState = { snapshot: { windows: [{ id: "premium", label: "Premium", usedPercent: 35 }] } };
		expect(overviewWindow("copilot", { claudeWindow: "session" })).toBeUndefined();
		expect(overviewView({ copilot }, { agents: ["copilot"] }).rows[0].label).toBe("Copilot");
	});

	it("marks how far through each row's window we are", () => {
		const HOUR = 60 * MIN;
		// 4 of 5 hours gone, 30% used: well within pace.
		const session: ProviderState = { snapshot: { windows: [{ id: "session", label: "5h", usedPercent: 30, resetsAt: NOW + HOUR, windowMs: 5 * HOUR }] } };
		expect(overviewView({ claude: session }, { agents: ["claude"] }, NOW).rows[0]).toEqual({ label: "Claude", value: "30%", fraction: 0.3, level: "normal", pace: 0.8 });
		// No window length: no tick.
		const unknown: ProviderState = { snapshot: { windows: [{ id: "session", label: "5h", usedPercent: 30, resetsAt: NOW + HOUR }] } };
		expect(overviewView({ claude: unknown }, { agents: ["claude"] }, NOW).rows[0]).not.toHaveProperty("pace");
	});

	it("defaults to every agent", () => {
		expect(overviewAgents({})).toEqual(["claude", "codex", "copilot", "grok"]);
		expect(overviewAgents({ agents: [] })).toEqual([]);
	});
});
