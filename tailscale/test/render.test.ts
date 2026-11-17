import { describe, expect, it } from "vitest";

import { DARK_ICON_COLOR, ICON_COLORS, iconTintForBackground, keyImage, keySvg, normalizeHex } from "../src/render";

describe("iconTintForBackground", () => {
	it("darkens icons on light backgrounds", () => {
		expect(iconTintForBackground("#f0e68c")).toBe(DARK_ICON_COLOR);
		expect(iconTintForBackground("#ffffff")).toBe(DARK_ICON_COLOR);
	});

	it("leaves icons alone on dark or missing backgrounds", () => {
		expect(iconTintForBackground("#00963c")).toBeUndefined();
		expect(iconTintForBackground(undefined)).toBeUndefined();
		expect(iconTintForBackground("nonsense")).toBeUndefined();
	});
});

describe("normalizeHex", () => {
	it("expands and lowercases", () => {
		expect(normalizeHex("#ABC")).toBe("#aabbcc");
		expect(normalizeHex("00963C")).toBe("#00963c");
		expect(normalizeHex("rgb(0,0,0)")).toBeUndefined();
	});
});

describe("keySvg", () => {
	it("draws the background and icon color", () => {
		const svg = keySvg({ icon: "connected", background: "#00963c" });
		expect(svg).toContain('fill="#00963c"');
		expect(svg).toContain(ICON_COLORS.connected);
	});

	it("tints the icon on light backgrounds", () => {
		const svg = keySvg({ icon: "account", background: "#ffffff" });
		expect(svg).toContain(DARK_ICON_COLOR);
		expect(svg).not.toContain(ICON_COLORS.account);
	});

	it("omits the background when none is set", () => {
		expect(keySvg({ icon: "disconnected" })).not.toContain("<rect");
	});

	it("adds a badge for errors", () => {
		expect(keySvg({ icon: "disconnected", error: true })).toContain("#d93025");
	});

	it("encodes as a data URL", () => {
		const url = keyImage({ icon: "exitNodeOn" });
		expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
		expect(Buffer.from(url.split(",")[1], "base64").toString()).toBe(keySvg({ icon: "exitNodeOn" }));
	});
});
