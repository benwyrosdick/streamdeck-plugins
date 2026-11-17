import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Thin wrapper around the local `gh` (GitHub CLI).
 *
 * The plugin uses the local `gh` CLI (which carries the user's existing auth)
 * rather than a raw GitHub API token, so no extra credentials are needed.
 *
 * Counts are obtained with a single GraphQL `search { issueCount }` call: it
 * returns just the total without fetching any result rows, which is by far the
 * cheapest way to count matching issues and pull requests.
 */

// Timeouts (ms). Counts hit the network, so give them a generous budget;
// `gh run list`/`run view` (especially with a --workflow filter) can be slow,
// so they get more headroom; auth checks are quick.
export const COUNT_TIMEOUT = 8_000;
export const RUN_TIMEOUT = 15_000;
export const AUTH_TIMEOUT = 5_000;

export type RunResult = { ok: boolean; stdout: string; stderr: string };

export type Runner = (file: string, args: string[], timeout: number) => Promise<RunResult>;

export type GhCliOptions = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (file: string) => boolean;
	runner?: Runner;
	/** Epoch milliseconds; injectable for tests. */
	now?: () => number;
	/** Called whenever a command fails, for logging. */
	onError?: (args: string[], result: RunResult) => void;
};

/** A GitHub Actions run, as reported by `gh run list --json`. */
export type WorkflowRun = {
	status?: string;
	conclusion?: string;
	workflowName?: string;
	headBranch?: string;
	displayTitle?: string;
	url?: string;
	databaseId?: number;
};

/** Completed and total steps across every job of a run. */
export type StepProgress = { completed: number; total: number };

/**
 * Thrown when a gh call fails because the GitHub API rate limit is hit.
 *
 * Carries the epoch (ms) when the limit is expected to reset, so the UI can
 * show a countdown and callers can stop polling until then.
 */
export class RateLimitError extends Error {
	constructor(readonly resetAt: number) {
		super("GitHub API rate limited");
		this.name = "RateLimitError";
	}
}

/**
 * Where the CLI usually lives. Stream Deck launches plugins with a minimal
 * PATH, so well-known install locations are probed before falling back to a
 * bare PATH lookup.
 */
export function candidatePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	switch (platform) {
		case "darwin":
			return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/opt/local/bin/gh"];
		case "win32": {
			const programFiles = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"];
			const dirs = [...new Set(programFiles.filter((dir): dir is string => !!dir))].map((dir) => path.win32.join(dir, "GitHub CLI"));
			if (env.LOCALAPPDATA) {
				dirs.push(path.win32.join(env.LOCALAPPDATA, "Programs", "GitHub CLI"));
			}
			return dirs.map((dir) => path.win32.join(dir, "gh.exe"));
		}
		default:
			return ["/usr/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"];
	}
}

export class GhCli {
	readonly #platform: NodeJS.Platform;
	readonly #env: NodeJS.ProcessEnv;
	readonly #exists: (file: string) => boolean;
	readonly #runner: Runner;
	readonly #now: () => number;
	readonly #onError: GhCliOptions["onError"];
	#binary: string | undefined;

	constructor(options: GhCliOptions = {}) {
		this.#platform = options.platform ?? process.platform;
		this.#env = options.env ?? process.env;
		this.#exists = options.exists ?? existsSync;
		this.#runner = options.runner ?? execRunner;
		this.#now = options.now ?? Date.now;
		this.#onError = options.onError;
	}

	/** The command (file + args) used to invoke `gh`. */
	buildCommand(args: string[]): [string, string[]] {
		this.#binary ??=
			candidatePaths(this.#platform, this.#env).find((file) => this.#exists(file)) ??
			(this.#platform === "win32" ? "gh.exe" : "gh");
		return [this.#binary, args];
	}

	async run(args: string[], timeout = COUNT_TIMEOUT): Promise<RunResult> {
		const [file, fullArgs] = this.buildCommand(args);
		const result = await this.#runner(file, fullArgs, timeout);
		if (!result.ok) {
			this.#onError?.(args, result);
		}
		return result;
	}

	// ------------------------------------------------------------------ //
	// Rate-limit detection
	// ------------------------------------------------------------------ //

	/** Throws {@link RateLimitError} if `stderr` indicates GitHub rate limiting. */
	async checkRateLimit(stderr: string): Promise<void> {
		if (!stderr.toLowerCase().includes("rate limit")) {
			return;
		}
		// Secondary/abuse limits aren't reflected in /rate_limit; back off a
		// minute and try again.
		throw new RateLimitError((await this.rateLimitReset()) ?? this.#now() + 60_000);
	}

	/**
	 * Soonest reset (epoch ms) among currently-exhausted resources, or
	 * `undefined`. The /rate_limit endpoint does NOT count against the rate
	 * limit, so it is always safe to call — even while rate limited.
	 */
	async rateLimitReset(): Promise<number | undefined> {
		const { ok, stdout } = await this.run(
			["api", "rate_limit", "--jq", "[.resources | to_entries[] | select(.value.remaining == 0) | .value.reset] | min"],
			AUTH_TIMEOUT,
		);
		const seconds = ok ? Number.parseFloat(stdout.trim()) : Number.NaN;
		return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
	}

	// ------------------------------------------------------------------ //
	// Read operations
	// ------------------------------------------------------------------ //

	/** True if `gh` is installed and authenticated. */
	async authenticated(): Promise<boolean> {
		const { ok, stderr } = await this.run(["auth", "status"], AUTH_TIMEOUT);
		if (!ok) {
			await this.checkRateLimit(stderr);
		}
		return ok;
	}

	/**
	 * Number of issues/PRs matching a GitHub search `query`, or `undefined` on
	 * any failure. Uses GraphQL `search(type: ISSUE, first: 0) { issueCount }`
	 * so only the total comes back, not the matching rows.
	 */
	async count(query: string): Promise<number | undefined> {
		if (!query.trim()) {
			return undefined;
		}
		const gql = "query($q: String!) { search(query: $q, type: ISSUE, first: 0) { issueCount } }";
		// Both -f flags force string typing; the GraphQL variable is String!.
		// -f (vs -F) also avoids gh interpreting a leading '@' as a file path.
		const { ok, stdout, stderr } = await this.run(
			["api", "graphql", "-f", `query=${gql}`, "-f", `q=${query}`, "--jq", ".data.search.issueCount"],
			COUNT_TIMEOUT,
		);
		if (!ok) {
			await this.checkRateLimit(stderr);
			return undefined;
		}
		return parseCount(stdout);
	}

	/**
	 * Most recent GitHub Actions run for a repo (optionally filtered by
	 * workflow and branch). `null` when the repo has no matching runs,
	 * `undefined` on failure — letting callers tell "no runs" apart from
	 * "couldn't fetch".
	 */
	async latestRun(repo: string, workflow = "", branch = ""): Promise<WorkflowRun | null | undefined> {
		if (!repo) {
			return undefined;
		}
		const args = [
			"run", "list", "-R", repo, "--limit", "1",
			"--json", "status,conclusion,workflowName,headBranch,displayTitle,url,databaseId",
		];
		if (workflow) {
			args.push("--workflow", workflow);
		}
		if (branch) {
			args.push("--branch", branch);
		}
		const { ok, stdout, stderr } = await this.run(args, RUN_TIMEOUT);
		if (!ok) {
			await this.checkRateLimit(stderr);
			return undefined;
		}
		const runs = parseJson<WorkflowRun[]>(stdout);
		if (!Array.isArray(runs)) {
			return undefined;
		}
		return runs[0] ?? null;
	}

	/**
	 * Step progress for a run, aggregated across its jobs; `undefined` on
	 * failure or when no steps are known yet. Counts every step GitHub reports
	 * (including the implicit set-up/complete steps), so it matches what the
	 * Actions UI shows per job. While a run is still going, the total grows as
	 * not-yet-started jobs register their steps.
	 */
	async runStepProgress(repo: string, runId: number): Promise<StepProgress | undefined> {
		if (!repo || !runId) {
			return undefined;
		}
		const { ok, stdout, stderr } = await this.run(["run", "view", String(runId), "-R", repo, "--json", "jobs"], RUN_TIMEOUT);
		if (!ok) {
			await this.checkRateLimit(stderr);
			return undefined;
		}
		const data = parseJson<{ jobs?: { steps?: { status?: string }[] }[] }>(stdout);
		const steps = (data?.jobs ?? []).flatMap((job) => job.steps ?? []);
		if (steps.length === 0) {
			return undefined;
		}
		return { completed: steps.filter((step) => step.status === "completed").length, total: steps.length };
	}

	/**
	 * Number of unread notifications for the authenticated user, or
	 * `undefined` on failure.
	 *
	 * Scoped to `repo` (owner/name) when given, else across all repos. With
	 * `participating` only threads the user is directly involved in count.
	 * `reason` filters to a single notification reason (e.g. "assign",
	 * "review_requested") client-side, mirroring the inbox's Filters — the REST
	 * API can't filter by reason server-side. The endpoint returns only unread
	 * threads by default, matching the inbox badge.
	 */
	async notificationCount(repo = "", participating = false, reason = ""): Promise<number | undefined> {
		const endpoint = repo ? `/repos/${repo}/notifications` : "/notifications";
		const args = ["api", "--paginate", endpoint, "-X", "GET", "-f", "per_page=100"];
		if (participating) {
			args.push("-f", "participating=true");
		}
		// Emit one line per matching thread id so pagination just accumulates
		// lines. A reason filter is a jq select on each thread's `.reason`.
		args.push("--jq", reason ? `.[] | select(.reason == "${reason}") | .id` : ".[].id");
		const { ok, stdout, stderr } = await this.run(args, COUNT_TIMEOUT);
		if (!ok) {
			await this.checkRateLimit(stderr);
			return undefined;
		}
		return stdout.split("\n").filter((line) => line.trim()).length;
	}
}

/** Parses `--jq` count output, falling back to a full GraphQL envelope (older gh). */
export function parseCount(stdout: string): number | undefined {
	const text = stdout.trim();
	if (!text) {
		return undefined;
	}
	if (/^\d+$/.test(text)) {
		return Number.parseInt(text, 10);
	}
	const count = parseJson<{ data?: { search?: { issueCount?: unknown } } }>(text)?.data?.search?.issueCount;
	return typeof count === "number" ? count : undefined;
}

function parseJson<T>(text: string): T | undefined {
	if (!text.trim()) {
		return undefined;
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/** Runs a command and resolves with its outcome; never rejects. */
const execRunner: Runner = (file, args, timeout) =>
	new Promise((resolve) => {
		execFile(file, args, { timeout, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr || error?.message || "" });
		});
	});
