import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { parseProfiles, parseProfilesJson, type Profile, type TailscaleStatus } from "./status";

/**
 * Thin wrapper around the local `tailscale` CLI.
 *
 * The plugin deliberately talks to the local daemon through the CLI rather
 * than the Tailscale cloud API, so no API key is needed.
 */

// Timeouts (ms). Status reads are quick; mutations can block on handshake or
// browser re-auth, so they get a generous budget.
export const STATUS_TIMEOUT = 4_000;
export const MUTATION_TIMEOUT = 15_000;

export type RunResult = { ok: boolean; stdout: string; stderr: string };

export type Runner = (file: string, args: string[], timeout: number) => Promise<RunResult>;

export type TailscaleCliOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (file: string) => boolean;
	runner?: Runner;
	/** Called whenever a command fails, for logging. */
	onError?: (args: string[], result: RunResult) => void;
};

/**
 * Where the CLI usually lives. Stream Deck launches plugins with a minimal
 * PATH, so well-known install locations are probed before falling back to a
 * bare PATH lookup.
 */
export function candidatePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	switch (platform) {
		case "darwin":
			return [
				// Mac App Store and standalone builds ship the CLI inside the app bundle.
				"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
				"/opt/homebrew/bin/tailscale",
				"/usr/local/bin/tailscale",
			];
		case "win32": {
			const programFiles = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"];
			return [...new Set(programFiles.filter((dir): dir is string => !!dir))].map((dir) =>
				path.win32.join(dir, "Tailscale", "tailscale.exe"),
			);
		}
		default:
			return ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];
	}
}

export class TailscaleCli {
	readonly #platform: NodeJS.Platform;
	readonly #env: NodeJS.ProcessEnv;
	readonly #exists: (file: string) => boolean;
	readonly #runner: Runner;
	readonly #onError: TailscaleCliOptions["onError"];
	#binary: string | undefined;
	#accessDenied = false;

	constructor(options: TailscaleCliOptions = {}) {
		this.#platform = options.platform ?? process.platform;
		this.#env = options.env ?? process.env;
		this.#exists = options.exists ?? existsSync;
		this.#runner = options.runner ?? execRunner;
		this.#onError = options.onError;
	}

	/** The command (file + leading args) used to invoke `tailscale`. */
	buildCommand(args: string[]): [string, string[]] {
		this.#binary ??=
			candidatePaths(this.#platform, this.#env).find((file) => this.#exists(file)) ??
			(this.#platform === "win32" ? "tailscale.exe" : "tailscale");
		return [this.#binary, args];
	}

	async run(args: string[], timeout = STATUS_TIMEOUT): Promise<RunResult> {
		const [file, fullArgs] = this.buildCommand(args);
		const result = await this.#runner(file, fullArgs, timeout);
		if (!result.ok) {
			this.#onError?.(args, result);
		}
		return result;
	}

	// ------------------------------------------------------------------ //
	// Read operations
	// ------------------------------------------------------------------ //

	/** Parsed `tailscale status --json`, or `undefined` on any failure. */
	async getStatus(): Promise<TailscaleStatus | undefined> {
		const { ok, stdout } = await this.run(["status", "--json"]);
		if (!ok || !stdout.trim()) {
			return undefined;
		}
		try {
			return JSON.parse(stdout) as TailscaleStatus;
		} catch {
			return undefined;
		}
	}

	/**
	 * Profiles from `tailscale switch --list`, or `undefined` when the list
	 * can't be read (e.g. access denied) so the UI can surface a hint instead
	 * of an empty picker.
	 */
	async listProfiles(): Promise<Profile[] | undefined> {
		const json = await this.run(["switch", "--list", "--json"]);
		this.#accessDenied = isAccessDenied(json.stderr);
		const fromJson = json.ok ? parseProfilesJson(json.stdout) : undefined;
		if (fromJson || this.#accessDenied) {
			return fromJson;
		}
		// Older Tailscale: only the table.
		const { ok, stdout, stderr } = await this.run(["switch", "--list"]);
		this.#accessDenied = isAccessDenied(stderr);
		if (!ok || this.#accessDenied) {
			return undefined;
		}
		return parseProfiles(stdout);
	}

	/**
	 * Whether the last profile listing was refused because this user isn't
	 * Tailscale's operator. The operator is set per profile, so a newly added
	 * account needs `sudo tailscale set --operator=$USER` once.
	 */
	get accessDenied(): boolean {
		return this.#accessDenied;
	}

	// ------------------------------------------------------------------ //
	// Mutating operations
	// ------------------------------------------------------------------ //
	up(): Promise<boolean> {
		return this.#mutate(["up"]);
	}

	down(): Promise<boolean> {
		return this.#mutate(["down"]);
	}

	setExitNode(value: string): Promise<boolean> {
		return this.#mutate(["set", `--exit-node=${value}`]);
	}

	clearExitNode(): Promise<boolean> {
		return this.#mutate(["set", "--exit-node="]);
	}

	switch(profile: string): Promise<boolean> {
		return this.#mutate(["switch", profile]);
	}

	async #mutate(args: string[]): Promise<boolean> {
		return (await this.run(args, MUTATION_TIMEOUT)).ok;
	}
}

/** Runs a command and resolves with its outcome; never rejects. */
const execRunner: Runner = (file, args, timeout) =>
	new Promise((resolve) => {
		execFile(file, args, { timeout, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
			resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr || error?.message || "" });
		});
	});

const isAccessDenied = (stderr: string): boolean => stderr.toLowerCase().includes("access denied");
