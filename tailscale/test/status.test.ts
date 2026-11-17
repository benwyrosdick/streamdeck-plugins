import { describe, expect, it } from "vitest";

import {
	activeExitNode,
	backendState,
	currentAccount,
	exitNodeCandidates,
	isConnected,
	niceName,
	parseProfiles,
	type TailscaleStatus,
} from "../src/tailscale/status";

function sampleStatus(): TailscaleStatus {
	return {
		BackendState: "Running",
		CurrentTailnet: { Name: "example.com" },
		Peer: {
			keyA: {
				DNSName: "node-a.example.ts.net.",
				HostName: "hosta",
				TailscaleIPs: ["100.64.0.1"],
				ExitNodeOption: true,
				ExitNode: false,
			},
			keyB: {
				DNSName: "node-b.example.ts.net.",
				HostName: "hostb",
				TailscaleIPs: ["100.64.0.2"],
				ExitNodeOption: true,
				ExitNode: true, // currently active exit node
			},
			keyC: {
				DNSName: "plain.example.ts.net.",
				HostName: "hostc",
				TailscaleIPs: ["100.64.0.3"],
				ExitNodeOption: false,
				ExitNode: false,
			},
		},
	};
}

describe("backendState / isConnected", () => {
	it("reads the backend state", () => {
		expect(backendState(sampleStatus())).toBe("Running");
		expect(backendState(undefined)).toBeUndefined();
		expect(backendState({})).toBeUndefined();
	});

	it("is connected only when running", () => {
		expect(isConnected(sampleStatus())).toBe(true);
		expect(isConnected({ BackendState: "Stopped" })).toBe(false);
		expect(isConnected(undefined)).toBe(false);
	});
});

describe("currentAccount", () => {
	it("returns the current tailnet name", () => {
		expect(currentAccount(sampleStatus())).toBe("example.com");
	});

	it("is undefined when missing", () => {
		expect(currentAccount(undefined)).toBeUndefined();
		expect(currentAccount({})).toBeUndefined();
		expect(currentAccount({ CurrentTailnet: null })).toBeUndefined();
	});
});

describe("niceName", () => {
	it("uses the first DNS label", () => {
		expect(niceName({ DNSName: "node-a.example.ts.net.", HostName: "hosta" })).toBe("node-a");
	});

	it("falls back to the host name", () => {
		expect(niceName({ DNSName: "", HostName: "ip-10-1-11-233" })).toBe("ip-10-1-11-233");
	});
});

describe("activeExitNode", () => {
	it("returns the active peer", () => {
		expect(activeExitNode(sampleStatus())).toEqual({
			name: "node-b",
			ip: "100.64.0.2",
			dns: "node-b.example.ts.net",
		});
	});

	it("is undefined when no exit node is active", () => {
		const status = sampleStatus();
		for (const peer of Object.values(status.Peer!)) {
			peer.ExitNode = false;
		}
		expect(activeExitNode(status)).toBeUndefined();
	});
});

describe("exitNodeCandidates", () => {
	it("lists only advertised exit nodes, sorted", () => {
		expect(exitNodeCandidates(sampleStatus()).map((c) => c.name)).toEqual(["node-a", "node-b"]);
	});

	it("marks the active node", () => {
		const byName = Object.fromEntries(exitNodeCandidates(sampleStatus()).map((c) => [c.name, c]));
		expect(byName["node-b"].active).toBe(true);
		expect(byName["node-a"].active).toBe(false);
	});

	it("is empty without a status", () => {
		expect(exitNodeCandidates({})).toEqual([]);
		expect(exitNodeCandidates(undefined)).toEqual([]);
	});
});

describe("parseProfiles", () => {
	it("parses rows and the current marker", () => {
		const profiles = parseProfiles(
			"ID     Tailnet          Account\n" +
				"abc123 example.com      alice@example.com\n" +
				"def456 other.org        bob@other.org      *\n",
		);
		expect(profiles).toEqual([
			{ id: "abc123", tailnet: "example.com", account: "alice@example.com", current: false },
			{ id: "def456", tailnet: "other.org", account: "bob@other.org", current: true },
		]);
	});

	it("handles Windows line endings", () => {
		expect(parseProfiles("ID Tailnet Account\r\nabc a.com alice *\r\n")).toEqual([
			{ id: "abc", tailnet: "a.com", account: "alice", current: true },
		]);
	});
});
