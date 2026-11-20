import { action } from "@elgato/streamdeck";

import type { View } from "../render";
import { AGENT_DEFAULTS, DEFAULT_AGENTS, overviewAgents, type OverviewSettings, overviewView, windowChoices } from "../views";
import { type DataSourceItem, KeyAction } from "./key-action";

/** Every chosen agent's tightest limit, stacked on one key. Press to refresh them all. */
@action({ UUID: "com.benwyrosdick.agent-usage.overview" })
export class Overview extends KeyAction<OverviewSettings> {
	protected override defaults(): OverviewSettings {
		const { colorize, warnAt, critAt } = AGENT_DEFAULTS;
		return { agents: DEFAULT_AGENTS, claudeWindow: "", codexWindow: "", colorize, warnAt, critAt };
	}

	protected override view(settings: OverviewSettings): View {
		const states = Object.fromEntries(overviewAgents(settings).map((id) => [id, this.store.state(id)]));
		return overviewView(states, settings);
	}

	/** The Claude / Codex window pickers list the windows each account actually has. */
	protected override async dataSource(event: string, settings: OverviewSettings): Promise<DataSourceItem[] | undefined> {
		if (event === "getClaudeWindows") return windowChoices("claude", this.store.state("claude").snapshot?.windows, settings.claudeWindow, "Most used");
		if (event === "getCodexWindows") return windowChoices("codex", this.store.state("codex").snapshot?.windows, settings.codexWindow, "Most used");
		return undefined;
	}

	protected override async press(_action: unknown, settings: OverviewSettings): Promise<void> {
		await Promise.all(overviewAgents(settings).map((id) => this.store.refresh(id)));
	}
}
