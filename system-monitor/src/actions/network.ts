import { type Action, action } from "@elgato/streamdeck";

import type { View } from "../render";
import { DISPLAY_DEFAULTS, type NetworkSettings, networkView } from "../views";
import { MonitorAction } from "./monitor-action";

/** Download or upload rate; combined adds the other direction. Press to switch direction. */
@action({ UUID: "com.benwyrosdick.system-monitor.network" })
export class Network extends MonitorAction<NetworkSettings> {
	protected override defaults(): NetworkSettings {
		return { ...DISPLAY_DEFAULTS, direction: "down", units: "bytes" };
	}

	protected override view(settings: NetworkSettings): View {
		return networkView(this.monitor.network(), { down: this.monitor.history("net:down"), up: this.monitor.history("net:up") }, settings);
	}

	protected override async press(action: Action<NetworkSettings>, settings: NetworkSettings): Promise<void> {
		await this.saveSettings(action, { ...settings, direction: settings.direction === "up" ? "down" : "up" });
	}
}
