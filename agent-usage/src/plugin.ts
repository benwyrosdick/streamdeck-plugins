import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { ClaudeUsage, CodexUsage, CopilotUsage, GrokUsage } from "./actions/agent-key";
import { Overview } from "./actions/overview";
import { type ClaudeCredentials, ClaudeProvider, type CredentialVault } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import { CopilotProvider } from "./providers/copilot";
import { GrokProvider } from "./providers/grok";
import { run } from "./providers/http";
import { UsageStore } from "./store";

streamDeck.logger.setLevel("info");

/** Plugin-wide settings, shared by every key and the inspectors. */
type GlobalSettings = {
	/** Opt-in: refresh an expired Claude Code login into the plugin's own copy. */
	claudeRefresh?: boolean;
	/** That copy. Never written back to Claude Code's credentials. */
	claudeOAuth?: ClaudeCredentials;
};

let globals: GlobalSettings = {};

const vault: CredentialVault = {
	refreshEnabled: () => globals.claudeRefresh === true,
	load: () => globals.claudeOAuth,
	save: async (credentials) => {
		globals = { ...globals, claudeOAuth: credentials };
		await streamDeck.settings.setGlobalSettings(globals as unknown as JsonObject);
	},
};

const store = new UsageStore([new ClaudeProvider({ run, vault }), new CodexProvider(), new CopilotProvider({ run }), new GrokProvider()]);

streamDeck.settings.onDidReceiveGlobalSettings<JsonObject>(async (ev) => {
	const next = ev.settings as GlobalSettings;
	const toggled = next.claudeRefresh !== globals.claudeRefresh;
	globals = next;
	// Turning refreshing off discards the plugin's copy of the login.
	if (!globals.claudeRefresh && globals.claudeOAuth) {
		const { claudeOAuth: _, ...rest } = globals;
		globals = rest;
		await streamDeck.settings.setGlobalSettings(globals as unknown as JsonObject);
	}
	if (toggled) {
		await store.refresh("claude");
	}
});

streamDeck.actions.registerAction(new ClaudeUsage(store));
streamDeck.actions.registerAction(new CodexUsage(store));
streamDeck.actions.registerAction(new CopilotUsage(store));
streamDeck.actions.registerAction(new GrokUsage(store));
streamDeck.actions.registerAction(new Overview(store));

// Tick every 15 seconds while any key is showing: reset countdowns stay
// current, and each agent is polled on its own (much longer) interval, only
// while a visible key shows it.
store.start(15_000, () => streamDeck.actions.length > 0);

await streamDeck.connect();
globals = await streamDeck.settings.getGlobalSettings<GlobalSettings & JsonObject>();
// Keys can appear before the global settings arrive; re-read Claude with the opt-in in effect.
if (globals.claudeRefresh) {
	await store.refresh("claude");
}
