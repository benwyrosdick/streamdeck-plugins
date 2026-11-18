/**
 * Turns provider state and key settings into what a key shows. Pure
 * functions, so every style / threshold / error combination is easy to test.
 */
import type { ProviderErrorKind, ProviderId, UsageWindow } from "./providers/types";
import { type GaugeView, type Level, type OverviewRow, type OverviewView, type Style, STYLES } from "./render";
import type { ProviderState } from "./store";

/** Settings every agent key shares. */
export type AgentSettings = {
	/** Window id (`session`, `weekly`, `opus`, …); blank = the provider's first window. */
	window?: string;
	/** Show percent used (default) or percent left. */
	metric?: "used" | "remaining";
	style?: Style;
	/** "combined" (default) adds when the window resets; "single" shows just the percentage. */
	layout?: "single" | "combined";
	/** Overrides the agent name in the header. */
	label?: string;
	/** Colour the key amber / red past the thresholds (default on). Thresholds always apply to percent used. */
	colorize?: boolean;
	warnAt?: number | string;
	critAt?: number | string;
};

export type OverviewSettings = Pick<AgentSettings, "colorize" | "warnAt" | "critAt"> & {
	agents?: ProviderId[];
	/** Claude's row: a window id (`session`, `weekly`), or blank for whichever is most used. */
	claudeWindow?: string;
	/** Codex's row, likewise. */
	codexWindow?: string;
};

/** Agents whose Overview row can be pinned to one window, and the setting that holds it. */
export const OVERVIEW_WINDOW_SETTINGS = { claude: "claudeWindow", codex: "codexWindow" } as const satisfies Partial<
	Record<ProviderId, keyof OverviewSettings>
>;

export const AGENTS: Record<ProviderId, { name: string; /** What fixes a missing or expired login. */ fix: string }> = {
	claude: { name: "Claude", fix: "run Claude Code" },
	codex: { name: "Codex", fix: "run codex" },
	copilot: { name: "Copilot", fix: "gh auth login" },
	grok: { name: "Grok", fix: "run grok" },
};

/** The windows each agent can have, for the inspector and for cycling on press. */
export const WINDOWS: Record<ProviderId, { id: string; name: string }[]> = {
	claude: [
		{ id: "session", name: "5-hour session" },
		{ id: "weekly", name: "Weekly (all models)" },
		{ id: "opus", name: "Weekly Opus" },
		{ id: "sonnet", name: "Weekly Sonnet" },
	],
	codex: [
		{ id: "session", name: "5-hour session" },
		{ id: "weekly", name: "Weekly" },
	],
	copilot: [
		{ id: "premium", name: "Premium requests (monthly)" },
		{ id: "chat", name: "Chat (monthly)" },
	],
	grok: [{ id: "credits", name: "Credits (weekly)" }],
};

export const DEFAULT_WARN = 70;
export const DEFAULT_CRIT = 90;
export const DEFAULT_AGENTS: ProviderId[] = ["claude", "codex", "copilot", "grok"];

/** Starting settings for an agent key; thresholds are strings to match the inspector's selects. */
export const AGENT_DEFAULTS = {
	window: "",
	metric: "used",
	style: "ring",
	layout: "combined",
	colorize: true,
	warnAt: String(DEFAULT_WARN),
	critAt: String(DEFAULT_CRIT),
} satisfies AgentSettings;

const MAX_LABEL = 10;

// ---------------------------------------------------------------------- //
// Thresholds and formatting
// ---------------------------------------------------------------------- //

function numberSetting(value: number | string | undefined, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "");
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function levelFor(usedPercent: number, settings: Pick<AgentSettings, "colorize" | "warnAt" | "critAt">): Level {
	if (settings.colorize === false) {
		return "normal";
	}
	const warn = numberSetting(settings.warnAt, DEFAULT_WARN);
	const crit = Math.max(warn, numberSetting(settings.critAt, DEFAULT_CRIT));
	if (usedPercent >= crit) return "critical";
	if (usedPercent >= warn) return "warning";
	return "normal";
}

/** Time until a reset, compactly: 45m, 2h 13m, 3d 4h. */
export function formatCountdown(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const styleOf = (settings: AgentSettings): Style => (STYLES.includes(settings.style as Style) ? (settings.style as Style) : "ring");
const combined = (settings: AgentSettings): boolean => settings.layout !== "single";
const nameOf = (id: ProviderId, settings: AgentSettings): string => (settings.label ?? "").trim().slice(0, MAX_LABEL) || AGENTS[id].name;

/** The window a key shows: the chosen one, else the provider's first. */
export function selectWindow(windows: UsageWindow[], wanted: string | undefined): UsageWindow | undefined {
	return wanted ? windows.find((w) => w.id === wanted) : windows[0];
}

/** Short value + detail for each way a reading can be missing. */
const PROBLEMS: Record<ProviderErrorKind, (id: ProviderId) => { value: string; detail: string }> = {
	signedOut: (id) => ({ value: "Sign in", detail: AGENTS[id].fix }),
	expired: (id) => ({ value: "Expired", detail: AGENTS[id].fix }),
	unsupported: () => ({ value: "N/A", detail: "no plan usage" }),
	rateLimited: () => ({ value: "…", detail: "rate limited" }),
	failed: () => ({ value: "Error", detail: "offline?" }),
};

/** Login problems hide a stale reading; transient ones (offline, rate limited) keep showing it. */
const HIDES_READING = new Set<ProviderErrorKind>(["signedOut", "expired", "unsupported"]);

// ---------------------------------------------------------------------- //
// Views
// ---------------------------------------------------------------------- //

export function agentView(id: ProviderId, state: ProviderState, history: number[], settings: AgentSettings, now = Date.now()): GaugeView {
	const style = styleOf(settings);
	const name = nameOf(id, settings);
	const notice = (title: string, value: string, detail?: string): GaugeView => ({
		kind: "gauge",
		style,
		level: "idle",
		title,
		value,
		detail: combined(settings) ? detail : undefined,
		fraction: 0,
		history: [],
	});

	const { snapshot, error } = state;
	if (error && (!snapshot || HIDES_READING.has(error.kind))) {
		const problem = PROBLEMS[error.kind](id);
		return notice(name, problem.value, problem.detail);
	}
	if (!snapshot) {
		return notice(name, "…");
	}

	const window = selectWindow(snapshot.windows, settings.window);
	const fallbackLabel = WINDOWS[id].find((w) => w.id === settings.window)?.name;
	if (!window) {
		return notice(name, "N/A", fallbackLabel ? "not on plan" : undefined);
	}

	// Copilot's premium requests are its headline number; other windows name themselves.
	const title = id === "copilot" && window.id === "premium" ? name : `${name} ${window.label}`;
	// Inside the ring there's only room for the countdown itself.
	const countdown = window.resetsAt === undefined ? undefined : formatCountdown(window.resetsAt - now);
	const reset = countdown && (style === "ring" ? countdown : `resets ${countdown}`);
	if (window.usedPercent === undefined) {
		return { ...notice(title, "∞", reset), level: "normal" };
	}

	const remaining = settings.metric === "remaining";
	const used = window.usedPercent;
	const shown = remaining ? 100 - used : used;
	const left = window.remaining !== undefined ? `${window.remaining} left` : undefined;
	return {
		kind: "gauge",
		style,
		level: levelFor(used, settings),
		title,
		value: `${Math.round(shown)}%${remaining ? " left" : ""}`,
		detail: combined(settings) ? (reset ?? left) : undefined,
		fraction: Math.round(shown * 10) / 1000,
		history: history.map((v) => Math.round((remaining ? 100 - v : v) * 10) / 1000),
	};
}

/** The tightest limit an agent is up against: its most-used window. */
export function tightestWindow(windows: UsageWindow[]): UsageWindow | undefined {
	return windows
		.filter((w) => w.usedPercent !== undefined)
		.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
}

export function overviewAgents(settings: OverviewSettings): ProviderId[] {
	const chosen = Array.isArray(settings.agents) ? settings.agents : DEFAULT_AGENTS;
	return DEFAULT_AGENTS.filter((id) => chosen.includes(id));
}

/** The window an agent's Overview row is pinned to, if any. */
export function overviewWindow(id: ProviderId, settings: OverviewSettings): string | undefined {
	const key = OVERVIEW_WINDOW_SETTINGS[id as keyof typeof OVERVIEW_WINDOW_SETTINGS];
	return (key && settings[key]) || undefined;
}

/** Window labels shortened for an Overview row: "Week" won't fit beside the agent's name. */
const ROW_WINDOW_LABELS: Record<string, string> = { Week: "Wk" };

/** One row per agent: its pinned window, or else its most-used one. */
export function overviewView(states: Partial<Record<ProviderId, ProviderState>>, settings: OverviewSettings): OverviewView {
	const rows = overviewAgents(settings).map((id): OverviewRow => {
		const { snapshot, error } = states[id] ?? {};
		const pinned = overviewWindow(id, settings);
		const name = AGENTS[id].name;
		if (error && (!snapshot || HIDES_READING.has(error.kind))) {
			return { label: name, value: PROBLEMS[error.kind](id).value, fraction: 0, level: "idle" };
		}
		if (!snapshot) {
			return { label: name, value: "…", fraction: 0, level: "idle" };
		}
		const window = pinned ? snapshot.windows.find((w) => w.id === pinned) : tightestWindow(snapshot.windows);
		// Name the window only when it was chosen; "most used" can change from one refresh to the next.
		const label = pinned && window ? `${name} ${ROW_WINDOW_LABELS[window.label] ?? window.label}` : name;
		if (!window || window.usedPercent === undefined) {
			// An unlimited window reads ∞; a pinned window the plan doesn't have reads N/A.
			const unlimited = window !== undefined || (!pinned && snapshot.windows.length > 0);
			return { label, value: unlimited ? "∞" : "N/A", fraction: 0, level: "normal" };
		}
		return { label, value: `${Math.round(window.usedPercent)}%`, fraction: window.usedPercent / 100, level: levelFor(window.usedPercent, settings) };
	});
	return { kind: "overview", rows };
}
