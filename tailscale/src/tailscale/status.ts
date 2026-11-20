/**
 * Pure interpreters for the `tailscale status --json` payload. Nothing in here
 * touches a subprocess, so it is safe to unit test anywhere.
 */

/** The subset of a `tailscale status --json` peer the plugin reads. */
export type TailscalePeer = {
	DNSName?: string;
	HostName?: string;
	TailscaleIPs?: string[];
	ExitNode?: boolean;
	ExitNodeOption?: boolean;
};

/** The subset of the `tailscale status --json` payload the plugin reads. */
export type TailscaleStatus = {
	BackendState?: string;
	CurrentTailnet?: { Name?: string; StableID?: string } | null;
	Self?: { UserID?: number } | null;
	Peer?: Record<string, TailscalePeer> | null;
};

/** A peer that can act (or is acting) as an exit node. */
export type ExitNode = {
	name: string;
	dns: string;
	ip: string;
};

export type ExitNodeCandidate = ExitNode & { active: boolean };

/** A profile (a signed-in account on one tailnet) from `tailscale switch --list`. */
export type Profile = {
	id: string;
	/** The tailnet's display name when it has one ("VESYL"), else its domain. */
	tailnet: string;
	account: string;
	current: boolean;
	/** Set with `tailscale login --nickname`; defaults to the account. */
	nickname?: string;
};

/**
 * Parse `tailscale switch --list --json`, or `undefined` if it isn't that
 * (older versions only print the table; see {@link parseProfiles}).
 */
export function parseProfilesJson(output: string): Profile[] | undefined {
	let rows: unknown;
	try {
		rows = JSON.parse(output);
	} catch {
		return undefined;
	}
	if (!Array.isArray(rows)) return undefined;
	return rows
		.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && typeof row.id === "string")
		.map((row) => ({
			id: row.id as string,
			tailnet: typeof row.tailnet === "string" ? row.tailnet : "",
			account: typeof row.account === "string" ? row.account : "",
			current: row.selected === true,
			nickname: typeof row.nickname === "string" && row.nickname ? row.nickname : undefined,
		}));
}

/**
 * The Tailscale machine name (first label of DNSName), as shown in the admin
 * console. Falls back to the OS HostName, which on cloud VMs is an unhelpful
 * name like `ip-10-1-11-233`.
 */
export function niceName(peer: TailscalePeer): string {
	const dns = stripDot(peer.DNSName);
	if (dns) {
		return dns.split(".")[0];
	}
	return peer.HostName ?? "";
}

export function backendState(status: TailscaleStatus | null | undefined): string | undefined {
	return status?.BackendState;
}

export function isConnected(status: TailscaleStatus | null | undefined): boolean {
	return backendState(status) === "Running";
}

/** The current tailnet name; this is also the key per-account settings use. */
export function currentAccount(status: TailscaleStatus | null | undefined): string | undefined {
	return status?.CurrentTailnet?.Name || undefined;
}

/**
 * What identifies the signed-in account in a status: its tailnet and user.
 * When this changes, a different account (profile) has become current.
 */
export function accountSignature(status: TailscaleStatus | null | undefined): string | undefined {
	const tailnet = status?.CurrentTailnet?.StableID || status?.CurrentTailnet?.Name;
	return tailnet ? `${tailnet}/${status?.Self?.UserID ?? ""}` : undefined;
}

/** The peer currently acting as exit node, if any. */
export function activeExitNode(status: TailscaleStatus | null | undefined): ExitNode | undefined {
	for (const peer of peers(status)) {
		if (peer.ExitNode) {
			return toExitNode(peer);
		}
	}
	return undefined;
}

/**
 * Exit-node candidates derived from the status peers. `tailscale exit-node
 * list` has no JSON output, but every advertised exit node shows up as a peer
 * with `ExitNodeOption`, so we read it straight from the status payload.
 */
export function exitNodeCandidates(status: TailscaleStatus | null | undefined): ExitNodeCandidate[] {
	return peers(status)
		.filter((peer) => peer.ExitNodeOption)
		.map((peer) => ({ ...toExitNode(peer), active: !!peer.ExitNode }))
		.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/**
 * Parse the table printed by `tailscale switch --list` (versions without
 * `--json`). Tailnet names containing spaces can't be told apart from the
 * account here, which is why the JSON form is preferred:
 *
 * ```
 * ID     Tailnet      Account
 * abc123 example.com  alice@example.com
 * def456 other.org    bob@other.org      *
 * ```
 */
export function parseProfiles(output: string): Profile[] {
	const profiles: Profile[] = [];
	for (const line of output.split(/\r?\n/)) {
		const stripped = line.trim();
		if (!stripped || stripped.toUpperCase().startsWith("ID ")) {
			continue;
		}
		const current = stripped.endsWith("*");
		const parts = stripped.replace(/\*$/, "").trim().split(/\s+/);
		profiles.push({
			id: parts[0],
			tailnet: parts[1] ?? "",
			account: parts[2] ?? "",
			current,
		});
	}
	return profiles;
}

function peers(status: TailscaleStatus | null | undefined): TailscalePeer[] {
	return Object.values(status?.Peer ?? {});
}

function toExitNode(peer: TailscalePeer): ExitNode {
	return {
		name: niceName(peer),
		dns: stripDot(peer.DNSName),
		ip: peer.TailscaleIPs?.[0] ?? "",
	};
}

function stripDot(value: string | undefined): string {
	return (value ?? "").replace(/\.$/, "");
}
