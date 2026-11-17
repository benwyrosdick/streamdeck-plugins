import { type Action, action } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { View } from "../render";
import { backendState, currentAccount, isConnected, type TailscaleStatus } from "../tailscale/status";
import { TailscaleAction, truncate } from "./tailscale-action";

/** Status-aware on/off key: green when running, amber while connecting. */
@action({ UUID: "com.benwyrosdick.tailscale.toggle-connection" })
export class ToggleConnection extends TailscaleAction {
	protected override view(status: TailscaleStatus | undefined): View {
		if (!status) {
			return { icon: "disconnected", background: "#787878", error: true };
		}

		// The account name persists across states; only icon/background change.
		const label = truncate(currentAccount(status));
		switch (backendState(status)) {
			case "Running":
				return { icon: "connected", background: "#00963c", label };
			case "Starting":
			case "NoState":
				return { icon: "connecting", background: "#c88c00", label };
			default:
				return { icon: "disconnected", label };
		}
	}

	protected override async press(action: Action<JsonObject>): Promise<void> {
		const connected = isConnected(await this.tailscale.status.get());
		await this.mutate(action, () => (connected ? this.tailscale.cli.down() : this.tailscale.cli.up()));
	}
}
