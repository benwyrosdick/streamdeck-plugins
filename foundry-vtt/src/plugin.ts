import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { CombatAction, MacroAction, PlaylistAction, SceneAction, SystemAction, TokenAction } from "./actions/foundry-action";
import { newPairingCode } from "./bridge/pairing";
import { DEFAULT_PORT } from "./bridge/protocol";
import { BridgeServer } from "./bridge/server";
import { Deck } from "./deck";
import { statusText } from "./status";

streamDeck.logger.setLevel("info");

/** Plugin-wide settings, shown in every key's inspector. */
type GlobalSettings = {
	/** What the Foundry module must be given to pair. */
	pairingCode?: string;
	/** The port to listen on (a string when edited in the inspector). */
	port?: number | string;
	/** Read-only status line, written by the plugin. */
	status?: string;
};

let globals: GlobalSettings = {};

const deck = new Deck();
const server = new BridgeServer({
	status: (status) => {
		void saveGlobals({ status: statusText(status) });
		if (status.state === "error") {
			streamDeck.logger.warn(statusText(status));
		}
	},
	connected: () => deck.onConnected(),
	disconnected: () => deck.onDisconnected(),
	views: (views) => deck.onViews(views),
	pressed: (id, ok, message) => {
		if (!ok) streamDeck.logger.info(`Press failed in Foundry: ${message ?? "unknown error"}`);
		deck.onPressed(id, ok, message);
	},
});
deck.attach(server);

const portOf = (settings: GlobalSettings): number => {
	const port = Number(settings.port);
	return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT;
};

async function saveGlobals(changes: GlobalSettings): Promise<void> {
	globals = { ...globals, ...changes };
	await streamDeck.settings.setGlobalSettings(globals as JsonObject);
}

streamDeck.settings.onDidReceiveGlobalSettings<JsonObject>(async (ev) => {
	const next = ev.settings as GlobalSettings;
	const portChanged = portOf(next) !== portOf(globals);
	globals = { ...next, status: globals.status };
	if (portChanged) {
		await server.start(portOf(globals), globals.pairingCode ?? "");
	}
});

// "New code" in the inspector: the paired window must pair again.
streamDeck.ui.onSendToPlugin<JsonObject>(async (ev) => {
	if ((ev.payload as { event?: string })?.event === "newCode") {
		const pairingCode = newPairingCode();
		server.setCode(pairingCode);
		await saveGlobals({ pairingCode });
	}
});

streamDeck.actions.registerAction(new MacroAction(deck));
streamDeck.actions.registerAction(new SceneAction(deck));
streamDeck.actions.registerAction(new TokenAction(deck));
streamDeck.actions.registerAction(new CombatAction(deck));
streamDeck.actions.registerAction(new PlaylistAction(deck));
streamDeck.actions.registerAction(new SystemAction(deck));

await streamDeck.connect();
globals = await streamDeck.settings.getGlobalSettings<GlobalSettings & JsonObject>();
if (!globals.pairingCode) {
	await saveGlobals({ pairingCode: newPairingCode(), port: portOf(globals) });
}
await server.start(portOf(globals), globals.pairingCode ?? "");

process.on("exit", () => void server.stop());
