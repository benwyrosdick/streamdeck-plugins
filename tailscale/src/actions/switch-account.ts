import { type Action, action } from "@elgato/streamdeck";

import { normalizeHex, type View } from "../render";
import { currentAccount, type TailscaleStatus } from "../tailscale/status";
import { type DataSourceItem, profileItems, showAlert, TailscaleAction, tailnetLookup, truncate } from "./tailscale-action";

/**
 * Colors are stored per account (keyed by tailnet, which is what
 * `tailscale status` reports for the current account), so a color follows its
 * account even if the A/B slots are swapped. `colorA`/`colorB` only mirror the
 * selected accounts' colors for display in the property inspector.
 */
export type SwitchAccountSettings = {
	profileA?: string;
	profileB?: string;
	colorA?: string;
	colorB?: string;
	accountColors?: Record<string, string>;
};

/** Shown in a color picker for an account that has no color yet; never stored as a color. */
export const DEFAULT_SWATCH = "#3c3c3c";

const SLOTS = [
	["profileA", "colorA"],
	["profileB", "colorB"],
] as const;

/** Toggles between two Tailscale accounts, tinting the key with the active account's color. */
@action({ UUID: "com.benwyrosdick.tailscale.switch-account" })
export class SwitchAccount extends TailscaleAction<SwitchAccountSettings> {
	protected override view(status: TailscaleStatus | undefined, settings: SwitchAccountSettings): View {
		if (!status) {
			return { icon: "account", error: true };
		}
		const account = currentAccount(status);
		return {
			icon: "account",
			background: account ? normalizeHex(settings.accountColors?.[account]) : undefined,
			label: account ? truncate(account) : undefined,
		};
	}

	protected override async press(action: Action<SwitchAccountSettings>, settings: SwitchAccountSettings): Promise<void> {
		const { profileA, profileB } = settings;
		if (!profileA || !profileB) {
			await showAlert(action);
			return;
		}

		// Switch to whichever configured profile isn't current.
		const current = (await this.tailscale.cli.listProfiles())?.find((p) => p.current)?.id;
		const target = current === profileA ? profileB : profileA;
		await this.mutate(action, () => this.tailscale.cli.switch(target));
	}

	protected override async reconcileSettings(
		previous: SwitchAccountSettings | undefined,
		next: SwitchAccountSettings,
	): Promise<SwitchAccountSettings | undefined> {
		const tailnets = tailnetLookup(await this.tailscale.cli.listProfiles());
		const colors = { ...next.accountColors };
		let changed = false;

		for (const [profileKey, colorKey] of SLOTS) {
			const tailnet = tailnets(next[profileKey]);
			if (previous?.[profileKey] !== next[profileKey]) {
				// A different account was picked: show its saved color.
				const shown = (tailnet && colors[tailnet]) || DEFAULT_SWATCH;
				if (next[colorKey] !== shown) {
					next[colorKey] = shown;
					changed = true;
				}
			} else if (previous?.[colorKey] !== next[colorKey] && tailnet) {
				// The user picked a color: remember it for that account.
				const color = normalizeHex(next[colorKey]);
				if (color) {
					colors[tailnet] = color;
					changed = true;
				}
			}
		}

		if (!changed) {
			return undefined;
		}
		next.accountColors = colors;
		return next;
	}

	protected override async settingsForInspector(settings: SwitchAccountSettings): Promise<SwitchAccountSettings | undefined> {
		const tailnets = tailnetLookup(await this.tailscale.cli.listProfiles());
		let changed = false;
		for (const [profileKey, colorKey] of SLOTS) {
			const tailnet = tailnets(settings[profileKey]);
			const shown = (tailnet && settings.accountColors?.[tailnet]) || DEFAULT_SWATCH;
			if (settings[colorKey] !== shown) {
				settings[colorKey] = shown;
				changed = true;
			}
		}
		return changed ? settings : undefined;
	}

	protected override async dataSource(event: string): Promise<DataSourceItem[] | undefined> {
		return event === "getProfiles" ? profileItems(this.tailscale.cli) : undefined;
	}
}
