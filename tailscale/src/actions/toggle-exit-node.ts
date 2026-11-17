import streamDeck, { type Action, action } from "@elgato/streamdeck";

import type { View } from "../render";
import { activeExitNode, currentAccount, exitNodeCandidates, type TailscaleStatus } from "../tailscale/status";
import { type DataSourceItem, showAlert, TailscaleAction, truncate } from "./tailscale-action";

/** Stored when the user wants Tailscale to pick the exit node. */
export const AUTO = "auto";
/** The `--exit-node` value for automatic selection. */
export const AUTO_EXIT_NODE = "auto:any";

export type ChosenExitNode = { value: string; label: string };

/**
 * The chosen node is remembered per network (tailnet), because a node from one
 * account doesn't exist on another. `exitNode` only mirrors the current
 * network's choice for display in the property inspector.
 */
export type ToggleExitNodeSettings = {
	exitNode?: string;
	nodesByNetwork?: Record<string, ChosenExitNode>;
};

/**
 * Toggles an exit node on/off. When the node picked for the current network
 * isn't available (e.g. right after switching accounts) it falls back to
 * Tailscale's automatic selection so pressing it never fails.
 */
@action({ UUID: "com.benwyrosdick.tailscale.toggle-exit-node" })
export class ToggleExitNode extends TailscaleAction<ToggleExitNodeSettings> {
	protected override view(status: TailscaleStatus | undefined, settings: ToggleExitNodeSettings): View {
		if (!status) {
			return { icon: "exitNodeOff", error: true };
		}
		const active = activeExitNode(status);
		if (active) {
			return { icon: "exitNodeOn", background: "#005ac8", label: truncate(active.name) };
		}
		return { icon: "exitNodeOff", label: truncate(configuredLabel(status, settings)) };
	}

	protected override async press(action: Action<ToggleExitNodeSettings>, settings: ToggleExitNodeSettings): Promise<void> {
		const status = await this.tailscale.status.get();
		if (!status) {
			await showAlert(action);
			return;
		}

		// Pressing always turns off whatever exit node is currently active.
		if (activeExitNode(status)) {
			await this.mutate(action, () => this.tailscale.cli.clearExitNode());
			return;
		}

		const target = targetFor(status, settings);
		await this.mutate(action, () => this.tailscale.cli.setExitNode(target));
	}

	protected override async reconcileSettings(
		previous: ToggleExitNodeSettings | undefined,
		next: ToggleExitNodeSettings,
	): Promise<ToggleExitNodeSettings | undefined> {
		const value = next.exitNode;
		if (!value || previous?.exitNode === value) {
			return undefined;
		}

		// Remember the pick for the network it was made on.
		const status = await this.tailscale.status.get();
		const label =
			value === AUTO ? autoShortLabel() : exitNodeCandidates(status).find((c) => c.ip === value)?.name || value;
		next.nodesByNetwork = { ...next.nodesByNetwork, [network(status)]: { value, label } };
		return next;
	}

	protected override async settingsForInspector(settings: ToggleExitNodeSettings): Promise<ToggleExitNodeSettings | undefined> {
		const value = chosenFor(await this.tailscale.status.get(), settings)?.value ?? AUTO;
		if (settings.exitNode === value) {
			return undefined;
		}
		settings.exitNode = value;
		return settings;
	}

	protected override async dataSource(event: string): Promise<DataSourceItem[] | undefined> {
		if (event !== "getExitNodes") {
			return undefined;
		}
		const candidates = exitNodeCandidates(await this.tailscale.status.get());
		return [
			{ value: AUTO, label: streamDeck.i18n.translate("ToggleExitNode.Auto") },
			...candidates.map((c) => ({ value: c.ip, label: c.name || c.ip })),
		];
	}
}

function network(status: TailscaleStatus | undefined): string {
	return currentAccount(status) ?? "";
}

function chosenFor(status: TailscaleStatus | undefined, settings: ToggleExitNodeSettings): ChosenExitNode | undefined {
	return settings.nodesByNetwork?.[network(status)];
}

/** The `--exit-node` value to apply on the current network. */
export function targetFor(status: TailscaleStatus, settings: ToggleExitNodeSettings): string {
	const value = chosenFor(status, settings)?.value;
	// Only honor the saved node if it still exists on this network.
	if (value && value !== AUTO && exitNodeCandidates(status).some((c) => c.ip === value)) {
		return value;
	}
	return AUTO_EXIT_NODE;
}

function configuredLabel(status: TailscaleStatus, settings: ToggleExitNodeSettings): string {
	const chosen = chosenFor(status, settings);
	return chosen && chosen.value !== AUTO ? chosen.label : autoShortLabel();
}

function autoShortLabel(): string {
	return streamDeck.i18n.translate("ToggleExitNode.AutoShort");
}
