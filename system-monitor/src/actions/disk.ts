import { type Action, action } from "@elgato/streamdeck";

import type { View } from "../render";
import { type DiskSettings, diskView, DISPLAY_DEFAULTS } from "../views";
import { type DataSourceItem, MonitorAction, showAlert } from "./monitor-action";

/** How full a drive is; combined adds free space. Press to cycle through drives. */
@action({ UUID: "com.benwyrosdick.system-monitor.disk" })
export class Disk extends MonitorAction<DiskSettings> {
	protected override defaults(): DiskSettings {
		return { ...DISPLAY_DEFAULTS, drive: "" };
	}

	protected override view(settings: DiskSettings): View {
		const path = settings.drive || this.monitor.systemDrive;
		const label = this.monitor.drives().find((d) => d.path === path)?.label;
		return diskView(this.monitor.disk(path), this.monitor.history(`disk:${path}`), settings, label);
	}

	protected override async press(action: Action<DiskSettings>, settings: DiskSettings): Promise<void> {
		const drives = await this.monitor.refreshDrives();
		if (drives.length < 2) {
			await showAlert(action);
			return;
		}
		const current = drives.findIndex((d) => d.path === (settings.drive || this.monitor.systemDrive));
		const next = drives[(current + 1) % drives.length];
		await this.saveSettings(action, { ...settings, drive: next.path === this.monitor.systemDrive ? "" : next.path });
		await this.monitor.refresh("disk", next.path);
	}

	protected override async dataSource(event: string): Promise<DataSourceItem[] | undefined> {
		if (event !== "getDrives") {
			return undefined;
		}
		const drives = await this.monitor.refreshDrives();
		return [
			{ label: "System drive", value: "" },
			// "C:" and "/" say it all; named volumes also show where they're mounted.
			...drives.map((d) => ({ label: [d.path, d.path.slice(0, -1)].includes(d.label) ? d.label : `${d.label} (${d.path})`, value: d.path })),
		];
	}
}
