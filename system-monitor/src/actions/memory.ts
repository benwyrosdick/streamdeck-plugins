import { action } from "@elgato/streamdeck";

import type { View } from "../render";
import { DISPLAY_DEFAULTS, type DisplaySettings, memoryView } from "../views";
import { MonitorAction } from "./monitor-action";

/** Memory in use; combined adds used / total. Press to refresh. */
@action({ UUID: "com.benwyrosdick.system-monitor.memory" })
export class Memory extends MonitorAction<DisplaySettings> {
	protected override defaults(): DisplaySettings {
		return { ...DISPLAY_DEFAULTS };
	}

	protected override view(settings: DisplaySettings): View {
		return memoryView(this.monitor.memory(), this.monitor.history("memory"), settings);
	}

	protected override async press(): Promise<void> {
		await this.monitor.refresh("memory");
	}
}
