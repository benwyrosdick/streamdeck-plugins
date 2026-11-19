/**
 * Stream Deck Bridge: lets the Foundry VTT Stream Deck plugin
 * (com.benwyrosdick.foundry-vtt) control this world.
 */
import { Bridge } from "./bridge.js";
import { Deck } from "./deck.js";
import { t } from "./i18n.js";

const MODULE_ID = "stream-deck-bridge";
const setting = (key) => game.settings.get(MODULE_ID, key);

let bridge;
let deck;

/** Connect from this browser? "auto" means only for GMs, so players never get a local-network prompt. */
function shouldConnect() {
	const mode = setting("connect");
	return mode === "always" || (mode === "auto" && game.user.isGM);
}

function restart() {
	bridge?.stop();
	if (shouldConnect()) bridge?.start();
}

function notify(level, key) {
	if (setting("notify") || level === "warn") ui.notifications?.[level](t(key));
}

Hooks.once("init", () => {
	const register = (key, options) => game.settings.register(MODULE_ID, key, { scope: "client", config: true, ...options });
	register("connect", {
		name: "SDBRIDGE.Settings.Connect.Name",
		hint: "SDBRIDGE.Settings.Connect.Hint",
		type: String,
		choices: { auto: "SDBRIDGE.Settings.Connect.auto", always: "SDBRIDGE.Settings.Connect.always", never: "SDBRIDGE.Settings.Connect.never" },
		default: "auto",
		onChange: restart,
	});
	register("pairingCode", {
		name: "SDBRIDGE.Settings.PairingCode.Name",
		hint: "SDBRIDGE.Settings.PairingCode.Hint",
		type: String,
		default: "",
		onChange: restart,
	});
	register("port", { name: "SDBRIDGE.Settings.Port.Name", hint: "SDBRIDGE.Settings.Port.Hint", type: Number, default: 3010, onChange: restart });
	register("host", { name: "SDBRIDGE.Settings.Host.Name", hint: "SDBRIDGE.Settings.Host.Hint", type: String, default: "127.0.0.1", onChange: restart });
	register("notify", { name: "SDBRIDGE.Settings.Notify.Name", hint: "SDBRIDGE.Settings.Notify.Hint", type: Boolean, default: true });
});

Hooks.once("ready", () => {
	bridge = new Bridge({
		config: () => ({ host: setting("host") || "127.0.0.1", port: Number(setting("port")) || 3010, code: setting("pairingCode") }),
		hello: () => ({ world: game.world?.title, user: game.user?.name, isGM: game.user?.isGM, foundry: game.version }),
		onMessage: (message) => deck.receive(message),
		onState: (state) => {
			switch (state) {
				case "connected":
					deck.reset();
					return notify("info", "Status.Connected");
				case "disconnected":
					return;
				case "noCode":
					return notify("warn", "Status.NoCode");
				case "badCode":
					return notify("warn", "Status.BadCode");
				case "badProof":
					return notify("warn", "Status.BadProof");
				case "replaced":
					return notify("info", "Status.Replaced");
			}
		},
	});
	deck = new Deck(bridge);
	deck.listen();
	game.modules.get(MODULE_ID).api = { bridge, deck, restart };
	if (shouldConnect()) bridge.start();
});
