import { type Action, action } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { View } from "../render";
import { isConnected, type TailscaleStatus } from "../tailscale/status";
import { TailscaleAction } from "./tailscale-action";

/** Runs `tailscale up`; lit green while connected. */
@action({ UUID: "com.benwyrosdick.tailscale.connect" })
export class Connect extends TailscaleAction {
	protected override view(status: TailscaleStatus | undefined): View {
		if (!status) {
			return { icon: "disconnected", error: true };
		}
		return isConnected(status) ? { icon: "connected", background: "#00963c" } : { icon: "disconnected" };
	}

	protected override press(action: Action<JsonObject>): Promise<void> {
		return this.mutate(action, () => this.tailscale.cli.up());
	}
}
