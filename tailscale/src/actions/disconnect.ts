import { type Action, action } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { View } from "../render";
import { isConnected, type TailscaleStatus } from "../tailscale/status";
import { TailscaleAction } from "./tailscale-action";

/** Runs `tailscale down`. */
@action({ UUID: "com.benwyrosdick.tailscale.disconnect" })
export class Disconnect extends TailscaleAction {
	protected override view(status: TailscaleStatus | undefined): View {
		if (!status) {
			return { icon: "disconnected", error: true };
		}
		return { icon: isConnected(status) ? "connected" : "disconnected" };
	}

	protected override press(action: Action<JsonObject>): Promise<void> {
		return this.mutate(action, () => this.tailscale.cli.down());
	}
}
