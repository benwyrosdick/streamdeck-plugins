import { describe, expect, it } from "vitest";

import { COLORS, ERROR_COLOR, escapeXml, formatCountdown, ICON_COLORS, keyImage, keySvg, truncate } from "../src/render";

describe("keySvg", () => {
	it("draws the background, icon and labels", () => {
		const svg = keySvg({ icon: "pr", top: "My Open", bottom: "3", background: COLORS.highlight });
		expect(svg).toContain(`fill="${COLORS.highlight}"`);
		expect(svg).toContain(ICON_COLORS.pr);
		expect(svg).toContain(">My Open</text>");
		expect(svg).toContain(">3</text>");
	});

	it("omits the background when none is set", () => {
		expect(keySvg({ icon: "issue" })).not.toContain("<rect");
	});

	it("rotates the spinner", () => {
		expect(keySvg({ icon: "ciRunning", rotation: 72 })).toContain("rotate(72 128 128)");
		expect(keySvg({ icon: "ciRunning" })).not.toContain("rotate(");
	});

	it("outlines errors", () => {
		expect(keySvg({ icon: "pr", error: true })).toContain(ERROR_COLOR);
		expect(keySvg({ icon: "pr" })).not.toContain(ERROR_COLOR);
	});

	it("escapes label text", () => {
		expect(keySvg({ top: "<a&b>" })).toContain(">&#60;a&#38;b&#62;</text>");
		expect(escapeXml(`"'`)).toBe("&#34;&#39;");
	});

	it("encodes as a data URL", () => {
		const url = keyImage({ icon: "inbox" });
		expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
		expect(Buffer.from(url.split(",")[1], "base64").toString()).toBe(keySvg({ icon: "inbox" }));
	});
});

describe("formatCountdown", () => {
	it("formats minutes and seconds", () => {
		expect(formatCountdown(205_000)).toBe("3m25s");
		expect(formatCountdown(9_500)).toBe("9s");
		expect(formatCountdown(-5)).toBe("0s");
	});
});

describe("truncate", () => {
	it("trims and shortens labels", () => {
		expect(truncate("  a very long button label ")).toBe("a very long ");
		expect(truncate(undefined)).toBe("");
	});
});
