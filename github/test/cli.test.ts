import { describe, expect, it } from "vitest";

import { AUTH_TIMEOUT, COUNT_TIMEOUT, GhCli, type GhCliOptions, parseCount, RateLimitError, RUN_TIMEOUT, type RunResult } from "../src/github/cli";

type Responder = (args: string[]) => Partial<RunResult>;

/** Records the commands run and answers each with a canned (or computed) result. */
function cli(result: Partial<RunResult> | Responder = {}, options: GhCliOptions = {}) {
	const calls: { file: string; args: string[]; timeout: number }[] = [];
	const runner = async (file: string, args: string[], timeout: number): Promise<RunResult> => {
		calls.push({ file, args, timeout });
		return { ok: true, stdout: "", stderr: "", ...(typeof result === "function" ? result(args) : result) };
	};
	return { cli: new GhCli({ platform: "linux", exists: () => false, runner, now: () => 1_000_000, ...options }), calls };
}

/** The value following `flag` in `args`. */
function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

describe("buildCommand", () => {
	it("prefers Homebrew on macOS", () => {
		const { cli: mac } = cli({}, { platform: "darwin", exists: (f) => f === "/opt/homebrew/bin/gh" });
		expect(mac.buildCommand(["auth", "status"])).toEqual(["/opt/homebrew/bin/gh", ["auth", "status"]]);
	});

	it("finds gh.exe under Program Files on Windows", () => {
		const { cli: win } = cli({}, {
			platform: "win32",
			env: { ProgramFiles: "D:\\Apps" },
			exists: (f) => f === "D:\\Apps\\GitHub CLI\\gh.exe",
		});
		expect(win.buildCommand([])[0]).toBe("D:\\Apps\\GitHub CLI\\gh.exe");
	});

	it("falls back to a PATH lookup", () => {
		expect(cli({}, { platform: "win32", env: {} }).cli.buildCommand([])[0]).toBe("gh.exe");
		expect(cli({}, { platform: "darwin" }).cli.buildCommand([])[0]).toBe("gh");
		expect(cli().cli.buildCommand(["x"])).toEqual(["gh", ["x"]]);
	});
});

describe("count", () => {
	it("parses the issue count from a GraphQL search", async () => {
		const { cli: c, calls } = cli({ stdout: "5\n" });
		expect(await c.count("repo:o/r type:pr")).toBe(5);
		expect(calls[0].timeout).toBe(COUNT_TIMEOUT);
		expect(calls[0].args.slice(0, 2)).toEqual(["api", "graphql"]);
		expect(calls[0].args).toContain("q=repo:o/r type:pr");
		expect(flag(calls[0].args, "--jq")).toBe(".data.search.issueCount");
	});

	it("short-circuits an empty query", async () => {
		const { cli: c, calls } = cli({ stdout: "999" });
		expect(await c.count("   ")).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("is undefined on failure or empty output", async () => {
		expect(await cli({ ok: false, stderr: "boom" }).cli.count("repo:o/r")).toBeUndefined();
		expect(await cli({ stdout: "" }).cli.count("repo:o/r")).toBeUndefined();
	});

	it("propagates rate limiting instead of swallowing it", async () => {
		const { cli: c } = cli((args) =>
			args[1] === "rate_limit" ? { stdout: "42\n" } : { ok: false, stderr: "API rate limit exceeded for user" },
		);
		await expect(c.count("repo:o/r")).rejects.toEqual(new RateLimitError(42_000));
	});
});

describe("parseCount", () => {
	it("accepts bare numbers and full GraphQL envelopes", () => {
		expect(parseCount("7")).toBe(7);
		expect(parseCount('{"data":{"search":{"issueCount":3}}}')).toBe(3);
		expect(parseCount("nope")).toBeUndefined();
	});
});

describe("latestRun", () => {
	it("needs a repo", async () => {
		const { cli: c, calls } = cli({ stdout: "[]" });
		expect(await c.latestRun("")).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("omits optional filters", async () => {
		const { cli: c, calls } = cli({ stdout: '[{"status":"completed"}]' });
		await c.latestRun("owner/repo");
		expect(calls[0].args).not.toContain("--workflow");
		expect(calls[0].args).not.toContain("--branch");
		expect(flag(calls[0].args, "-R")).toBe("owner/repo");
		expect(calls[0].timeout).toBe(RUN_TIMEOUT);
	});

	it("passes workflow and branch", async () => {
		const { cli: c, calls } = cli({ stdout: '[{"status":"completed"}]' });
		await c.latestRun("owner/repo", "ci.yml", "main");
		expect(flag(calls[0].args, "--workflow")).toBe("ci.yml");
		expect(flag(calls[0].args, "--branch")).toBe("main");
	});

	it("returns the first run, null for none, undefined on failure", async () => {
		expect(await cli({ stdout: '[{"status":"in_progress"}]' }).cli.latestRun("o/r")).toEqual({ status: "in_progress" });
		expect(await cli({ stdout: "[]" }).cli.latestRun("o/r")).toBeNull();
		expect(await cli({ ok: false, stderr: "err" }).cli.latestRun("o/r")).toBeUndefined();
		expect(await cli({ stdout: "not json" }).cli.latestRun("o/r")).toBeUndefined();
	});
});

describe("runStepProgress", () => {
	it("aggregates steps across jobs", async () => {
		const jobs = {
			jobs: [
				{ steps: [{ status: "completed" }, { status: "completed" }, { status: "in_progress" }] },
				{ steps: [{ status: "completed" }, { status: "queued" }] },
			],
		};
		const { cli: c, calls } = cli({ stdout: JSON.stringify(jobs) });
		expect(await c.runStepProgress("o/r", 99)).toEqual({ completed: 3, total: 5 });
		expect(calls[0].args).toEqual(["run", "view", "99", "-R", "o/r", "--json", "jobs"]);
	});

	it("is undefined when no steps are known yet", async () => {
		expect(await cli({ stdout: '{"jobs":[]}' }).cli.runStepProgress("o/r", 1)).toBeUndefined();
	});
});

describe("notificationCount", () => {
	it("counts lines from the global endpoint", async () => {
		const { cli: c, calls } = cli({ stdout: "a\nb\nc\n" });
		expect(await c.notificationCount()).toBe(3);
		expect(calls[0].args).toContain("/notifications");
		expect(flag(calls[0].args, "--jq")).toBe(".[].id");
	});

	it("scopes to a repo", async () => {
		const { cli: c, calls } = cli({ stdout: "" });
		expect(await c.notificationCount("owner/repo")).toBe(0);
		expect(calls[0].args).toContain("/repos/owner/repo/notifications");
	});

	it("passes participating and filters by reason with jq", async () => {
		const { cli: c, calls } = cli({ stdout: "x\n" });
		await c.notificationCount("", true, "review_requested");
		expect(calls[0].args).toContain("participating=true");
		expect(flag(calls[0].args, "--jq")).toContain('select(.reason == "review_requested")');
	});

	it("ignores blank lines, and is undefined on failure", async () => {
		expect(await cli({ stdout: "a\n\n \nb\n" }).cli.notificationCount()).toBe(2);
		expect(await cli({ ok: false, stderr: "err" }).cli.notificationCount()).toBeUndefined();
	});
});

describe("checkRateLimit", () => {
	it("throws with the reset time from /rate_limit", async () => {
		const { cli: c, calls } = cli({ stdout: "1234\n" });
		await expect(c.checkRateLimit("API rate limit exceeded for user")).rejects.toEqual(new RateLimitError(1_234_000));
		expect(calls[0].timeout).toBe(AUTH_TIMEOUT);
	});

	it("backs off a minute when the reset is unknown", async () => {
		await expect(cli({ stdout: "null" }).cli.checkRateLimit("secondary rate limit hit")).rejects.toEqual(new RateLimitError(1_060_000));
	});

	it("ignores unrelated errors", async () => {
		await expect(cli().cli.checkRateLimit("some other failure")).resolves.toBeUndefined();
	});
});

describe("authenticated", () => {
	it("reflects gh auth status", async () => {
		expect(await cli({ ok: true }).cli.authenticated()).toBe(true);
		expect(await cli({ ok: false, stderr: "not logged in" }).cli.authenticated()).toBe(false);
	});
});
