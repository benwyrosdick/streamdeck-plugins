import { describe, expect, it } from "vitest";

import { MUTATION_TIMEOUT, type RunResult, STATUS_TIMEOUT, TailscaleCli, type TailscaleCliOptions } from "../src/tailscale/cli";

/** Records the commands run and returns a canned result. */
function fakeRunner(result: Partial<RunResult> = {}) {
	const calls: { file: string; args: string[]; timeout: number }[] = [];
	const runner = async (file: string, args: string[], timeout: number): Promise<RunResult> => {
		calls.push({ file, args, timeout });
		return { ok: true, stdout: "", stderr: "", ...result };
	};
	return { calls, runner };
}

function cli(result: Partial<RunResult> = {}, options: TailscaleCliOptions = {}) {
	const fake = fakeRunner(result);
	return { cli: new TailscaleCli({ platform: "linux", exists: () => false, runner: fake.runner, ...options }), calls: fake.calls };
}

describe("buildCommand", () => {
	it("prefers the macOS app bundle", () => {
		const { cli: mac } = cli({}, { platform: "darwin", exists: () => true });
		expect(mac.buildCommand(["up"])).toEqual(["/Applications/Tailscale.app/Contents/MacOS/Tailscale", ["up"]]);
	});

	it("falls back to Homebrew on macOS", () => {
		const { cli: mac } = cli({}, { platform: "darwin", exists: (f) => f === "/opt/homebrew/bin/tailscale" });
		expect(mac.buildCommand(["up"])[0]).toBe("/opt/homebrew/bin/tailscale");
	});

	it("finds tailscale.exe under Program Files on Windows", () => {
		const { cli: win } = cli({}, {
			platform: "win32",
			env: { ProgramFiles: "D:\\Apps" },
			exists: (f) => f === "D:\\Apps\\Tailscale\\tailscale.exe",
		});
		expect(win.buildCommand(["status"])[0]).toBe("D:\\Apps\\Tailscale\\tailscale.exe");
	});

	it("falls back to a PATH lookup", () => {
		expect(cli({}, { platform: "win32", env: {} }).cli.buildCommand([])[0]).toBe("tailscale.exe");
		expect(cli({}, { platform: "darwin" }).cli.buildCommand([])[0]).toBe("tailscale");
	});
});

describe("getStatus", () => {
	it("parses JSON", async () => {
		const payload = { BackendState: "Running" };
		const { cli: c, calls } = cli({ stdout: JSON.stringify(payload) });
		expect(await c.getStatus()).toEqual(payload);
		expect(calls[0]).toMatchObject({ args: ["status", "--json"], timeout: STATUS_TIMEOUT });
	});

	it("is undefined on failure, bad JSON, or empty output", async () => {
		expect(await cli({ ok: false, stderr: "boom" }).cli.getStatus()).toBeUndefined();
		expect(await cli({ stdout: "not json" }).cli.getStatus()).toBeUndefined();
		expect(await cli({ stdout: "   " }).cli.getStatus()).toBeUndefined();
	});
});

describe("listProfiles", () => {
	it("parses profiles", async () => {
		const { cli: c } = cli({ stdout: "ID Tailnet Account\nabc a.com alice *\n" });
		expect(await c.listProfiles()).toEqual([{ id: "abc", tailnet: "a.com", account: "alice", current: true }]);
	});

	it("is undefined on failure or access denied", async () => {
		expect(await cli({ ok: false }).cli.listProfiles()).toBeUndefined();
		expect(await cli({ stderr: "Access denied: operator not set" }).cli.listProfiles()).toBeUndefined();
	});
});

describe("mutations", () => {
	it.each([
		["up", (c: TailscaleCli) => c.up(), ["up"]],
		["down", (c: TailscaleCli) => c.down(), ["down"]],
		["switch", (c: TailscaleCli) => c.switch("abc123"), ["switch", "abc123"]],
		["setExitNode", (c: TailscaleCli) => c.setExitNode("100.64.0.2"), ["set", "--exit-node=100.64.0.2"]],
		["clearExitNode", (c: TailscaleCli) => c.clearExitNode(), ["set", "--exit-node="]],
	])("%s runs the right command", async (_name, run, args) => {
		const { cli: c, calls } = cli();
		expect(await run(c)).toBe(true);
		expect(calls[0]).toMatchObject({ args, timeout: MUTATION_TIMEOUT });
	});

	it("reports failure and calls onError", async () => {
		const errors: string[][] = [];
		const { cli: c } = cli({ ok: false }, { onError: (args) => errors.push(args) });
		expect(await c.down()).toBe(false);
		expect(errors).toEqual([["down"]]);
	});
});
