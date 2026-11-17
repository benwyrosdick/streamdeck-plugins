import { type Action, action } from "@elgato/streamdeck";

import type { View } from "../render";
import { DEFAULT_OVERVIEW, DISPLAY_DEFAULTS, overviewMetrics, type OverviewSettings, overviewView } from "../views";
import { MonitorAction } from "./monitor-action";

/** Several metrics stacked on one key. Press to refresh them all. */
@action({ UUID: "com.benwyrosdick.system-monitor.overview" })
export class Overview extends MonitorAction<OverviewSettings> {
	protected override defaults(): OverviewSettings {
		const { colorize, warnAt, critAt } = DISPLAY_DEFAULTS;
		return { metrics: DEFAULT_OVERVIEW, colorize, warnAt, critAt };
	}

	protected override view(settings: OverviewSettings): View {
		const metrics = overviewMetrics(settings);
		const m = this.monitor;
		return overviewView(
			{
				cpu: metrics.includes("cpu") ? m.cpu() : undefined,
				gpu: metrics.includes("gpu") ? m.gpu() : undefined,
				memory: metrics.includes("memory") ? m.memory() : undefined,
				disk: metrics.includes("disk") ? m.disk() : undefined,
				network: metrics.includes("network") ? m.network() : undefined,
				networkHistory: m.history("net:down"),
			},
			settings,
		);
	}

	protected override async press(_action: Action<OverviewSettings>, settings: OverviewSettings): Promise<void> {
		await Promise.all(overviewMetrics(settings).map((metric) => this.monitor.refresh(metric)));
	}
}
