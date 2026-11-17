import streamDeck from "@elgato/streamdeck";

import { Connect } from "./actions/connect";
import { Disconnect } from "./actions/disconnect";
import { SwitchAccount } from "./actions/switch-account";
import type { Tailscale } from "./actions/tailscale-action";
import { ToggleConnection } from "./actions/toggle-connection";
import { ToggleExitNode } from "./actions/toggle-exit-node";
import { TailscaleCli } from "./tailscale/cli";
import { StatusStore } from "./tailscale/status-store";

streamDeck.logger.setLevel("info");

const cli = new TailscaleCli({
	onError: (args, { stderr }) => streamDeck.logger.warn(`tailscale ${args.join(" ")} failed: ${stderr.trim().slice(0, 200)}`),
});
const tailscale: Tailscale = { cli, status: new StatusStore(cli) };

streamDeck.actions.registerAction(new Connect(tailscale));
streamDeck.actions.registerAction(new Disconnect(tailscale));
streamDeck.actions.registerAction(new ToggleConnection(tailscale));
streamDeck.actions.registerAction(new SwitchAccount(tailscale));
streamDeck.actions.registerAction(new ToggleExitNode(tailscale));

// Keep visible keys current. The store's cache means this costs at most one
// `tailscale status` call per cache window, however many keys are showing.
tailscale.status.startPolling(1_000, () => streamDeck.actions.length > 0);

streamDeck.connect();
