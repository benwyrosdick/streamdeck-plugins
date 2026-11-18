import { describe, expect, it } from "vitest";

import { ACCENT, escapeXml, fitSize, type GaugeView, keyImage, keySvg, SOLID, STYLES } from "../src/render";

const base: GaugeView = {
	kind: "gauge",
	style: "classic",
	level: "normal",
	title: "CPU",
	value: "20%",
	fraction: 0.2,
	history: [0.1, 0.3, 0.2],
};

describe("keySvg", () => {
	it("draws every style with the title, value and a graph or meter", () => {
		for (const style of STYLES) {
			const svg = keySvg({ ...base, style });
			expect(svg).toContain(">CPU</text>");
			expect(svg).toContain(">20%</text>");
			expect(svg).toMatch(style === "bars" ? /<rect x="14" y="\d+" width/ : /<path d="M/);
		}
	});

	it("colours by level", () => {
		expect(keySvg({ ...base, level: "warning" })).toContain(ACCENT.warning);
		expect(keySvg({ ...base, level: "critical", style: "ring" })).toContain(ACCENT.critical);
		const solid = keySvg({ ...base, level: "critical", style: "solid" });
		expect(solid).toContain(SOLID.critical[0]);
		expect(solid).not.toContain(SOLID.normal[0]);
	});

	it("adds the detail line only when given", () => {
		expect(keySvg({ ...base, detail: "6.1 GB / 16.0 GB" })).toContain(">6.1 GB / 16.0 GB</text>");
		expect(keySvg(base)).not.toContain("GB");
	});

	it("fills the bar meter in proportion", () => {
		const filled = (fraction: number) => keySvg({ ...base, style: "bars", fraction }).split(`fill="${ACCENT.normal}"`).length - 1;
		// The status dot and value text are accent-coloured too.
		expect(filled(0)).toBe(2);
		expect(filled(0.5)).toBe(2 + 5);
		expect(filled(1)).toBe(2 + 10);
	});

	it("skips the ring's value arc at zero", () => {
		expect(keySvg({ ...base, style: "ring", fraction: 0 }).match(/<path /g)).toHaveLength(1);
		expect(keySvg({ ...base, style: "ring", fraction: 0.5 }).match(/<path /g)).toHaveLength(2);
	});

	it("draws overview rows", () => {
		const svg = keySvg({
			kind: "overview",
			rows: [
				{ label: "CPU", value: "20%", fraction: 0.2, level: "normal" },
				{ label: "RAM", value: "91%", fraction: 0.91, level: "critical" },
			],
		});
		expect(svg).toContain(">RAM</text>");
		expect(svg).toContain(ACCENT.critical);
		expect(keySvg({ kind: "overview", rows: [] })).toContain("No metrics");
	});

	it("escapes text", () => {
		expect(keySvg({ ...base, title: "<a&b>" })).toContain(">&#60;a&#38;b&#62;</text>");
		expect(escapeXml(`"'`)).toBe("&#34;&#39;");
	});

	it("encodes as a data URL", () => {
		const url = keyImage(base);
		expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
		expect(Buffer.from(url.split(",")[1], "base64").toString()).toBe(keySvg(base));
	});
});

describe("overview rows", () => {
	it("give a label the room its value leaves", () => {
		const row = (label: string, value: string) => keySvg({ kind: "overview", rows: [{ label, value, fraction: 0.4, level: "normal" }] });
		const labelSize = (svg: string) => Number(/font-size="(\d+)"[^>]*text-anchor="start">/.exec(svg)?.[1]);
		// A short value leaves room for "Claude Wk" at a readable size; a long one squeezes it.
		expect(labelSize(row("Claude Wk", "42%"))).toBeGreaterThanOrEqual(14);
		expect(labelSize(row("Claude Wk", "Expired"))).toBeLessThan(labelSize(row("Claude Wk", "42%")));
	});
});

describe("fitSize", () => {
	it("shrinks long text to fit", () => {
		expect(fitSize("20%", 46, 128)).toBe(46);
		expect(fitSize("1023.5 KB/s", 46, 128)).toBeLessThan(25);
	});
});
