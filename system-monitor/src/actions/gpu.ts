import { action } from "@elgato/streamdeck";

import type { View } from "../render";
import { DISPLAY_DEFAULTS, type DisplaySettings, gpuView } from "../views";
import { MonitorAction } from "./monitor-action";

/** GPU utilisation; combined adds temperature and GPU memory. Press to refresh. */
@action({ UUID: "com.benwyrosdick.system-monitor.gpu" })
export class Gpu extends MonitorAction<DisplaySettings> {
	protected override defaults(): DisplaySettings {
		return { ...DISPLAY_DEFAULTS };
	}

	protected override view(settings: DisplaySettings): View {
		return gpuView(this.monitor.gpu(), this.monitor.history("gpu"), settings);
	}

	protected override async press(): Promise<void> {
		await this.monitor.refresh("gpu");
	}
}
