import { action } from "@elgato/streamdeck";

import type { View } from "../render";
import { cpuView, DISPLAY_DEFAULTS, type DisplaySettings } from "../views";
import { MonitorAction } from "./monitor-action";

/** CPU utilisation; combined adds the package temperature (where readable) and the busiest core. Press to refresh. */
@action({ UUID: "com.benwyrosdick.system-monitor.cpu" })
export class Cpu extends MonitorAction<DisplaySettings> {
	protected override defaults(): DisplaySettings {
		return { ...DISPLAY_DEFAULTS };
	}

	protected override view(settings: DisplaySettings): View {
		return cpuView(this.monitor.cpu(), this.monitor.history("cpu"), settings);
	}

	protected override async press(): Promise<void> {
		await this.monitor.refresh("cpu");
	}
}
