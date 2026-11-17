import streamDeck, { type Action, action } from "@elgato/streamdeck";

import type { View } from "../render";
import { backendState, currentAccount, isConnected, type TailscaleStatus } from "../tailscale/status";
import { type DataSourceItem, profileItems, TailscaleAction, tailnetLookup, truncate } from "./tailscale-action";

export type ToggleConnectionSettings = {
	/** Profile id from `tailscale switch --list`; blank toggles whichever account was used last. */
	profile?: string;
	/**
	 * The chosen profile's tailnet, kept alongside the id because it's what
	 * `tailscale status` reports for the active account — so the key can tell
	 * whether its tailnet is the connected one without listing profiles.
	 */
	tailnet?: string;
};

/** States `tailscale switch` passes through before settling. */
const SETTLING_STATES = new Set(["NoState", "Starting"]);

/** How long to wait for a switched-to account to settle before deciding whether to bring it up. */
export const SWITCH_SETTLE_MS = 5_000;
const SWITCH_POLL_MS = 250;

/**
 * Status-aware on/off key: green when running, amber while connecting.
 *
 * With an account chosen, the key belongs to that tailnet: it's only lit while
 * that tailnet is the connected one, and pressing it while another tailnet (or
 * nothing) is connected switches to it and connects. A row of these, one per
 * tailnet, switches between tailnets with a single press.
 */
@action({ UUID: "com.benwyrosdick.tailscale.toggle-connection" })
export class ToggleConnection extends TailscaleAction<ToggleConnectionSettings> {
	protected override view(status: TailscaleStatus | undefined, settings: ToggleConnectionSettings): View {
		if (!status) {
			return { icon: "disconnected", background: "#787878", error: true };
		}

		const current = currentAccount(status);
		const own = !settings.profile || (!!settings.tailnet && settings.tailnet === current);
		// The account name persists across states; only icon/background change.
		const label = truncate(settings.profile ? settings.tailnet : current);
		if (!own) {
			return { icon: "disconnected", label };
		}
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

	protected override async press(action: Action<ToggleConnectionSettings>, settings: ToggleConnectionSettings): Promise<void> {
		const status = await this.tailscale.status.get();
		const { cli } = this.tailscale;

		if (!settings.profile) {
			await this.mutate(action, () => (isConnected(status) ? cli.down() : cli.up()));
			return;
		}

		const profile = settings.profile;
		const active = (await cli.listProfiles())?.find((p) => p.current)?.id === profile;
		if (active && isConnected(status)) {
			await this.mutate(action, () => cli.down());
			return;
		}

		await this.mutate(action, async () => {
			if (!active && !(await cli.switch(profile))) {
				return false;
			}
			// An account remembers whether it was left running; only bring it up if it wasn't.
			const settled = await this.#settle();
			return isConnected(settled) || backendState(settled) === "Starting" || cli.up();
		});
	}

	/** Status once a switch has settled (or the wait runs out). */
	async #settle(): Promise<TailscaleStatus | undefined> {
		const deadline = Date.now() + SWITCH_SETTLE_MS;
		for (;;) {
			const status = await this.tailscale.status.get({ force: true });
			const state = backendState(status);
			if (state === "Running" || !SETTLING_STATES.has(state ?? "") || Date.now() >= deadline) {
				return status;
			}
			await new Promise((resolve) => setTimeout(resolve, SWITCH_POLL_MS));
		}
	}

	protected override async reconcileSettings(
		previous: ToggleConnectionSettings | undefined,
		next: ToggleConnectionSettings,
	): Promise<ToggleConnectionSettings | undefined> {
		if (previous?.profile === next.profile && (next.tailnet || !next.profile)) {
			return undefined;
		}
		return this.#withTailnet(next);
	}

	protected override settingsForInspector(settings: ToggleConnectionSettings): Promise<ToggleConnectionSettings | undefined> {
		// Accounts can be renamed or removed; refresh the stored tailnet whenever the inspector opens.
		return this.#withTailnet(settings);
	}

	protected override async dataSource(event: string): Promise<DataSourceItem[] | undefined> {
		if (event !== "getProfiles") {
			return undefined;
		}
		return profileItems(this.tailscale.cli, [{ value: "", label: streamDeck.i18n.translate("ToggleConnection.LastUsed") }]);
	}

	/** `settings` with `tailnet` matching `profile`, or `undefined` if it already does (or can't be looked up). */
	async #withTailnet(settings: ToggleConnectionSettings): Promise<ToggleConnectionSettings | undefined> {
		if (!settings.profile) {
			if (settings.tailnet === undefined) {
				return undefined;
			}
			const { tailnet: _, ...rest } = settings;
			return rest;
		}
		const profiles = await this.tailscale.cli.listProfiles();
		if (!profiles) {
			return undefined;
		}
		const tailnet = tailnetLookup(profiles)(settings.profile);
		return tailnet === settings.tailnet ? undefined : { ...settings, tailnet };
	}
}
