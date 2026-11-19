import type { BridgeStatus } from "./bridge/server";

/** The connection status as one line for the inspector. */
export function statusText(status: BridgeStatus): string {
	switch (status.state) {
		case "starting":
			return "Starting…";
		case "connected": {
			const { world, user, isGM } = status.client;
			const who = [user, isGM ? "(GM)" : undefined].filter(Boolean).join(" ");
			return `Connected${world ? ` to ${world}` : ""}${who ? ` as ${who}` : ""}`;
		}
		case "error":
			return `Not listening: ${status.message}`;
		case "listening":
			return status.rejected === "badCode"
				? `Rejected a Foundry window with the wrong pairing code (port ${status.port})`
				: `Waiting for Foundry on port ${status.port}`;
	}
}
