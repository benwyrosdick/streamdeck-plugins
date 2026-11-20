import { type Action, action } from "@elgato/streamdeck";

import type { ProviderId } from "../providers/types";
import type { View } from "../render";
import { AGENT_DEFAULTS, type AgentSettings, agentView, selectWindow, windowChoices } from "../views";
import { type DataSourceItem, KeyAction } from "./key-action";

/**
 * One agent's usage for one window. Pressing the key steps through the
 * windows the account actually has (e.g. 5-hour → weekly → Opus) and
 * refreshes the reading.
 */
export abstract class AgentKey extends KeyAction<AgentSettings> {
	protected abstract readonly provider: ProviderId;

	protected override defaults(): AgentSettings {
		return { ...AGENT_DEFAULTS };
	}

	protected override view(settings: AgentSettings): View {
		const state = this.store.state(this.provider);
		const windowId = selectWindow(state.snapshot?.windows ?? [], settings.window)?.id ?? settings.window ?? "";
		return agentView(this.provider, state, this.store.history(this.provider, windowId), settings);
	}

	/** The Window picker lists the windows this account actually has (models come and go). */
	protected override async dataSource(event: string, settings: AgentSettings): Promise<DataSourceItem[] | undefined> {
		if (event !== "getWindows") return undefined;
		return windowChoices(this.provider, this.store.state(this.provider).snapshot?.windows, settings.window, "First available");
	}

	protected override async press(action: Action<AgentSettings>, settings: AgentSettings): Promise<void> {
		const windows = this.store.state(this.provider).snapshot?.windows ?? [];
		if (windows.length > 1) {
			const current = windows.findIndex((w) => w.id === selectWindow(windows, settings.window)?.id);
			const next = windows[(current + 1) % windows.length];
			await this.saveSettings(action, { ...settings, window: next.id });
		}
		await this.store.refresh(this.provider);
	}
}

@action({ UUID: "com.benwyrosdick.agent-usage.claude" })
export class ClaudeUsage extends AgentKey {
	protected override readonly provider = "claude";
}

@action({ UUID: "com.benwyrosdick.agent-usage.codex" })
export class CodexUsage extends AgentKey {
	protected override readonly provider = "codex";
}

@action({ UUID: "com.benwyrosdick.agent-usage.copilot" })
export class CopilotUsage extends AgentKey {
	protected override readonly provider = "copilot";
}

@action({ UUID: "com.benwyrosdick.agent-usage.grok" })
export class GrokUsage extends AgentKey {
	protected override readonly provider = "grok";
}
