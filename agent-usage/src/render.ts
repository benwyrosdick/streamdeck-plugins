/**
 * Key artwork, generated as SVG on the 144×144 key canvas.
 *
 * Only features Stream Deck's SVG renderer handles reliably are used (shapes,
 * paths, linear gradients, opacity); "glow" is layered translucent strokes
 * rather than filters.
 */

export const STYLES = ["classic", "neon", "ring", "bars", "solid"] as const;
export type Style = (typeof STYLES)[number];

/** Threshold colouring: normal, ≥ warning, ≥ critical; `idle` when there's no reading. */
export type Level = "normal" | "warning" | "critical" | "idle";

/** A single metric on a key. Also the render-dedup signature. */
export type GaugeView = {
	kind: "gauge";
	style: Style;
	level: Level;
	/** Header, e.g. "CPU", "GPU 64°C", "NET ↓". */
	title: string;
	/** The big reading, e.g. "39%", "3.6 MB/s". */
	value: string;
	/** Secondary line for combined keys, e.g. "6.1 GB / 16.0 GB". */
	detail?: string;
	/** How full the ring / bar meter is, 0–1. */
	fraction: number;
	/** Recent readings scaled to 0–1, oldest first. */
	history: number[];
};

export type OverviewRow = { label: string; value: string; fraction: number; level: Level };

/** Several metrics stacked on one key. */
export type OverviewView = { kind: "overview"; rows: OverviewRow[] };

export type View = GaugeView | OverviewView;

export const ACCENT: Record<Level, string> = {
	normal: "#34d399",
	warning: "#fbbf24",
	critical: "#f87171",
	idle: "#64748b",
};

/** Solid-style backgrounds: [top-left, bottom-right]. */
export const SOLID: Record<Level, [string, string]> = {
	normal: ["#10b981", "#047857"],
	warning: ["#f59e0b", "#b45309"],
	critical: ["#ef4444", "#b91c1c"],
	idle: ["#475569", "#1e293b"],
};

const SIZE = 144;
const FONT = "'Segoe UI', 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const WHITE = "#ffffff";
const MUTED = "#94a3b8";
const TRACK = "#263041";

/** The SVG markup for `view`. */
export function keySvg(view: View): string {
	const body = view.kind === "overview" ? overview(view) : gauge(view);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
}

/** `keySvg` as a data URL suitable for `setImage` / `setFeedback`. */
export function keyImage(view: View): string {
	return `data:image/svg+xml;base64,${Buffer.from(keySvg(view)).toString("base64")}`;
}

// ---------------------------------------------------------------------- //
// Styles
// ---------------------------------------------------------------------- //

function gauge(view: GaugeView): string {
	switch (view.style) {
		case "neon":
			return neon(view);
		case "ring":
			return ring(view);
		case "bars":
			return bars(view);
		case "solid":
			return solid(view);
		default:
			return classic(view);
	}
}

/** Where the value (and optional detail) sit, leaving room for a graph below. */
function layout(view: GaugeView, single: { value: number }, combined: { value: number; detail: number }) {
	return view.detail ? { combined: true, ...combined } : { combined: false, detail: 0, ...single };
}

function classic(view: GaugeView): string {
	const accent = ACCENT[view.level];
	const at = layout(view, { value: 88 }, { value: 76, detail: 100 });
	return [
		rect("#161b26"),
		text(view.title, SIZE / 2, at.combined ? 28 : 32, 20, MUTED, 600),
		text(view.value, SIZE / 2, at.value, at.combined ? 40 : 46, accent, 700),
		view.detail ? text(view.detail, SIZE / 2, at.detail, 16, "#cbd5e1", 600) : "",
		sparkline(view.history, { left: 14, right: 130, top: at.combined ? 112 : 106, bottom: 134 }, accent, { width: 3.5 }),
	].join("");
}

function neon(view: GaugeView): string {
	const accent = ACCENT[view.level];
	const at = layout(view, { value: 84 }, { value: 76, detail: 100 });
	// Ids are per level so keys composed into one image (previews) don't share gradients.
	return [
		gradient("neon-bg", "#111a33", "#0a0f1e", true),
		rect("url(#neon-bg)"),
		gradient(`neon-fill-${view.level}`, accent, accent, true, [0.55, 0.05]),
		`<rect x="14" y="${at.combined ? 13 : 15}" width="5" height="22" rx="2.5" fill="${accent}"/>`,
		text(view.title, 27, at.combined ? 32 : 34, 21, "#e2e8f0", 700, "start", 108),
		text(view.value, SIZE / 2, at.value, at.combined ? 40 : 46, WHITE, 700),
		view.detail ? text(view.detail, SIZE / 2, at.detail, 16, accent, 600) : "",
		area(view.history, { left: 0, right: SIZE, top: at.combined ? 110 : 102, bottom: SIZE }, accent, `url(#neon-fill-${view.level})`, { glow: true }),
	].join("");
}

function ring(view: GaugeView): string {
	const accent = ACCENT[view.level];
	const cx = SIZE / 2;
	const cy = 66;
	const r = 50;
	const start = 135;
	const sweep = 270;
	const fraction = clamp01(view.fraction);
	return [
		rect("#0d1117"),
		arc(cx, cy, r, start, sweep, TRACK, 11),
		fraction > 0.005 ? arc(cx, cy, r, start, sweep * fraction, accent, 11) : "",
		text(view.value, cx, view.detail ? 70 : 77, 30, WHITE, 700, "middle", 74),
		view.detail ? text(view.detail, cx, 91, 14, MUTED, 600, "middle", 66) : "",
		text(view.title, cx, 134, 19, accent, 700, "middle", 96),
	].join("");
}

function bars(view: GaugeView): string {
	const accent = ACCENT[view.level];
	const at = layout(view, { value: 92 }, { value: 82, detail: 102 });
	const count = 10;
	const left = 14;
	const gap = 3;
	const width = (SIZE - 2 * left - gap * (count - 1)) / count;
	const bottom = 134;
	const filled = Math.round(clamp01(view.fraction) * count);
	const [minHeight, maxHeight] = at.combined ? [8, 20] : [10, 28];
	const meter = Array.from({ length: count }, (_, i) => {
		const height = minHeight + ((maxHeight - minHeight) * i) / (count - 1);
		const x = left + i * (width + gap);
		return `<rect x="${n(x)}" y="${n(bottom - height)}" width="${n(width)}" height="${n(height)}" rx="2.5" fill="${i < filled ? accent : TRACK}"/>`;
	}).join("");
	return [
		rect("#161b26"),
		`<rect width="${SIZE}" height="46" fill="#1f2633"/>`,
		text(view.title, 14, 31, 20, "#e2e8f0", 700, "start", 98),
		`<circle cx="125" cy="23" r="7" fill="${accent}"/>`,
		text(view.value, SIZE / 2, at.value, at.combined ? 34 : 40, accent, 700),
		view.detail ? text(view.detail, SIZE / 2, at.detail, 14, MUTED, 600) : "",
		meter,
	].join("");
}

function solid(view: GaugeView): string {
	const [from, to] = SOLID[view.level];
	const at = layout(view, { value: 82 }, { value: 74, detail: 98 });
	return [
		gradient(`solid-bg-${view.level}`, from, to, false),
		rect(`url(#solid-bg-${view.level})`),
		gradient("solid-fill", WHITE, WHITE, true, [0.3, 0.12]),
		area(view.history, { left: 8, right: 136, top: at.combined ? 108 : 100, bottom: 136 }, WHITE, "url(#solid-fill)", {}),
		`<rect x="6" y="6" width="132" height="132" rx="16" fill="none" stroke="${WHITE}" stroke-opacity="0.3" stroke-width="2"/>`,
		text(view.title, SIZE / 2, at.combined ? 30 : 34, 21, WHITE, 700),
		text(view.value, SIZE / 2, at.value, at.combined ? 40 : 46, WHITE, 700),
		view.detail ? text(view.detail, SIZE / 2, at.detail, 16, WHITE, 600) : "",
	].join("");
}

function overview(view: OverviewView): string {
	const rows = view.rows.slice(0, 5);
	const parts = [rect("#10151f")];
	if (!rows.length) {
		parts.push(text("No metrics", SIZE / 2, 78, 16, MUTED, 600));
	}
	const top = 6;
	const height = (SIZE - top * 2) / Math.max(1, rows.length);
	const labelSize = Math.min(16, height * 0.5);
	rows.forEach((row, i) => {
		const y = top + i * height;
		const baseline = y + height * 0.55;
		const barY = y + height * 0.68;
		const barHeight = Math.max(3, Math.min(6, height * 0.14));
		const accent = ACCENT[row.level];
		parts.push(
			text(row.label, 12, baseline, labelSize, MUTED, 700, "start", 52),
			text(row.value, 132, baseline, labelSize + 1, accent, 700, "end", 76),
			`<rect x="12" y="${n(barY)}" width="120" height="${n(barHeight)}" rx="${n(barHeight / 2)}" fill="${TRACK}"/>`,
			clamp01(row.fraction) > 0
				? `<rect x="12" y="${n(barY)}" width="${n(Math.max(barHeight, 120 * clamp01(row.fraction)))}" height="${n(barHeight)}" rx="${n(barHeight / 2)}" fill="${accent}"/>`
				: "",
		);
	});
	return parts.join("");
}

// ---------------------------------------------------------------------- //
// Primitives
// ---------------------------------------------------------------------- //

type Box = { left: number; right: number; top: number; bottom: number };

/** Readings → points spread across the box, oldest at the left. */
function points(history: number[], box: Box): [number, number][] {
	const values = history.length === 1 ? [history[0], history[0]] : history;
	const step = (box.right - box.left) / (values.length - 1);
	return values.map((v, i) => [box.left + i * step, box.bottom - clamp01(v) * (box.bottom - box.top)]);
}

function polyline(pts: [number, number][]): string {
	return pts.map(([x, y], i) => `${i ? "L" : "M"}${n(x)} ${n(y)}`).join("");
}

function sparkline(history: number[], box: Box, color: string, { width }: { width: number }): string {
	if (!history.length) {
		return "";
	}
	return `<path d="${polyline(points(history, box))}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** A filled area chart with a bright edge; `glow` adds soft halo strokes beneath it. */
function area(history: number[], box: Box, stroke: string, fill: string, { glow }: { glow?: boolean }): string {
	if (!history.length) {
		return "";
	}
	const pts = points(history, box);
	const line = polyline(pts);
	const first = pts[0];
	const last = pts[pts.length - 1];
	const shape = `${line}L${n(last[0])} ${box.bottom}L${n(first[0])} ${box.bottom}Z`;
	const edge = (width: number, opacity: number) =>
		`<path d="${line}" fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
	return [`<path d="${shape}" fill="${fill}"/>`, glow ? edge(10, 0.15) + edge(6, 0.3) : "", edge(3, 1)].join("");
}

/** An arc of `sweep` degrees starting at `start` (SVG angles: 0° = 3 o'clock, clockwise). */
function arc(cx: number, cy: number, r: number, start: number, sweep: number, color: string, width: number): string {
	const point = (deg: number) => {
		const rad = (deg * Math.PI) / 180;
		return `${n(cx + r * Math.cos(rad))} ${n(cy + r * Math.sin(rad))}`;
	};
	const large = sweep > 180 ? 1 : 0;
	return `<path d="M${point(start)}A${r} ${r} 0 ${large} 1 ${point(start + sweep)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
}

function rect(fill: string): string {
	return `<rect width="${SIZE}" height="${SIZE}" fill="${fill}"/>`;
}

/** A linear gradient: vertical (top → bottom) or diagonal; `opacity` is [from, to]. */
function gradient(id: string, from: string, to: string, vertical: boolean, opacity: [number, number] = [1, 1]): string {
	const direction = vertical ? `x1="0" y1="0" x2="0" y2="1"` : `x1="0" y1="0" x2="1" y2="1"`;
	return `<defs><linearGradient id="${id}" ${direction}><stop offset="0" stop-color="${from}" stop-opacity="${opacity[0]}"/><stop offset="1" stop-color="${to}" stop-opacity="${opacity[1]}"/></linearGradient></defs>`;
}

/** Average glyph width relative to font size for a bold sans-serif. */
const GLYPH_WIDTH = 0.6;

/** Text that shrinks to fit `maxWidth` rather than clipping at the key edge. */
function text(
	value: string,
	x: number,
	y: number,
	maxSize: number,
	color: string,
	weight: number,
	anchor: "start" | "middle" | "end" = "middle",
	maxWidth = 128,
): string {
	const size = fitSize(value, maxSize, maxWidth);
	return `<text x="${n(x)}" y="${n(y)}" fill="${color}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

export function fitSize(value: string, maxSize: number, maxWidth: number): number {
	const width = [...value].reduce((sum, ch) => sum + glyphWidth(ch), 0) * GLYPH_WIDTH;
	return Math.max(8, Math.min(maxSize, Math.floor(maxWidth / Math.max(width, 0.1))));
}

/** Rough relative glyph widths so "1.1" and "MB/s" aren't sized like "WWW". */
function glyphWidth(ch: string): number {
	if (" .,:;!|'".includes(ch)) return 0.5;
	if ("%MWm".includes(ch)) return 1.5;
	if (ch === "/") return 0.7;
	return 1;
}

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const n = (v: number): string => String(Math.round(v * 10) / 10);
