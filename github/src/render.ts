/**
 * Key artwork, generated as SVG so the icon, labels and background compose
 * into a single image without any image-processing dependency.
 *
 * Icons are drawn on a 256×256 grid and scaled onto the 144×144 key canvas.
 */

export type IconName = "pr" | "issue" | "inbox" | "ciSuccess" | "ciFailure" | "ciRunning" | "ciQueued" | "ciNeutral";

/** Everything visible on a key; also used as the render-dedup signature. */
export type View = {
	icon?: IconName;
	/** Degrees to rotate the icon by (animates the running spinner). */
	rotation?: number;
	/** Key background, as `#rrggbb`; omitted for the deck's default (black). */
	background?: string;
	/** Small label along the top (the button's name). */
	top?: string;
	/** Text in the middle, used when there's no icon. */
	center?: string;
	/** Text along the bottom: the count, or a status hint. */
	bottom?: string;
	/** Draw `bottom` smaller, for hints and progress rather than a count. */
	bottomSmall?: boolean;
	/** Outline the key to flag that it needs attention (no repo, not signed in). */
	error?: boolean;
};

export const COLORS = {
	green: "#3fb950",
	red: "#f85149",
	amber: "#e3a008",
	grey: "#8b949e",
	text: "#ffffff",
	/** Background when a count is non-zero: a subtle "something to look at" nudge. */
	highlight: "#284678",
	/** Background while rate limited. */
	rateLimited: "#b41e1e",
} as const;

export const ICON_COLORS: Record<IconName, string> = {
	pr: COLORS.green,
	issue: COLORS.green,
	inbox: COLORS.green,
	ciSuccess: COLORS.green,
	ciFailure: COLORS.red,
	ciRunning: COLORS.amber,
	ciQueued: COLORS.grey,
	ciNeutral: COLORS.grey,
};

/** Longest label shown on a key before it is truncated. */
export const MAX_LABEL = 12;

export const ERROR_COLOR = "#d93025";

const KEY_SIZE = 144;
const ICON_SIZE = 64;
const FONT = "Helvetica, Arial, sans-serif";

/** The SVG markup for a key showing `view`. */
export function keySvg(view: View): string {
	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">`,
		view.background ? `<rect width="${KEY_SIZE}" height="${KEY_SIZE}" fill="${view.background}"/>` : "",
	];

	if (view.icon) {
		const offset = (KEY_SIZE - ICON_SIZE) / 2;
		const rotate = view.rotation ? ` rotate(${view.rotation} 128 128)` : "";
		parts.push(
			`<g transform="translate(${offset} ${offset}) scale(${ICON_SIZE / 256})${rotate}">`,
			iconShapes(view.icon, ICON_COLORS[view.icon]),
			"</g>",
		);
	}

	if (view.top) {
		parts.push(text(view.top, 30, 22, "normal"));
	}
	if (view.center) {
		parts.push(text(view.center, 82, 28, "bold"));
	}
	if (view.bottom) {
		parts.push(view.bottomSmall ? text(view.bottom, 132, 26, "bold") : text(view.bottom, 134, 34, "bold"));
	}
	if (view.error) {
		parts.push(errorBadge());
	}

	parts.push("</svg>");
	return parts.join("");
}

/** `keySvg` as a data URL suitable for `setImage` / `setFeedback`. */
export function keyImage(view: View): string {
	return `data:image/svg+xml;base64,${Buffer.from(keySvg(view)).toString("base64")}`;
}

/** The bare icon shapes, drawn on a 256×256 grid. */
export function iconShapes(icon: IconName, color: string): string {
	const stroke = (width: number) => `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
	switch (icon) {
		case "pr":
			return [
				`<circle cx="72" cy="56" r="24" ${stroke(20)}/>`,
				`<circle cx="72" cy="200" r="24" ${stroke(20)}/>`,
				`<circle cx="184" cy="200" r="24" ${stroke(20)}/>`,
				`<path d="M72 80V176" ${stroke(20)}/>`,
				`<path d="M184 176V100Q184 64 148 64H112" ${stroke(20)}/>`,
				`<path d="M136 36L108 64L136 92" ${stroke(20)}/>`,
			].join("");
		case "issue":
			return [`<circle cx="128" cy="128" r="94" ${stroke(24)}/>`, `<circle cx="128" cy="128" r="28" fill="${color}"/>`].join("");
		case "inbox":
			return [
				`<path d="M40 136L80 60H176L216 136V192Q216 208 200 208H56Q40 208 40 192Z" ${stroke(22)}/>`,
				`<path d="M40 136H96L110 162H146L160 136H216" ${stroke(22)}/>`,
			].join("");
		case "ciSuccess":
			return `<path d="M56 134L104 182L204 82" ${stroke(32)}/>`;
		case "ciFailure":
			return `<path d="M68 68L188 188M188 68L68 188" ${stroke(32)}/>`;
		case "ciRunning":
			return spinner(color);
		case "ciQueued":
			return [72, 128, 184].map((cx) => `<circle cx="${cx}" cy="128" r="22" fill="${color}"/>`).join("");
		case "ciNeutral":
			return `<path d="M64 128H192" ${stroke(32)}/>`;
	}
}

/**
 * A circular arrow travelling clockwise: an arc with a gap at the top and an
 * arrowhead on its trailing end. Rotating the whole group animates it.
 */
function spinner(color: string): string {
	const r = 80;
	const point = (deg: number, radius = r) => {
		const rad = (deg * Math.PI) / 180;
		return [128 + radius * Math.cos(rad), 128 + radius * Math.sin(rad)].map((n) => n.toFixed(1)).join(" ");
	};
	// Angles in SVG coordinates: 0° is 3 o'clock, -90° is 12 o'clock.
	const start = -60;
	const end = -120 + 360;
	const head = end + 4;
	return [
		`<path d="M${point(start)}A${r} ${r} 0 1 1 ${point(end)}" fill="none" stroke="${color}" stroke-width="24" stroke-linecap="round"/>`,
		// The arrowhead points clockwise along the arc's tangent at its end.
		`<path d="M${point(end - 14, r - 34)}L${point(head + 18)}L${point(end - 14, r + 34)}Z" fill="${color}" stroke="${color}" stroke-width="8" stroke-linejoin="round"/>`,
	].join("");
}

/** Widest a line of text may be, leaving a small margin either side. */
const MAX_TEXT_WIDTH = 132;

/** Average glyph width relative to the font size; a rough fit for Helvetica-like faces. */
const GLYPH_WIDTH = 0.56;

function text(value: string, y: number, maxSize: number, weight: "normal" | "bold"): string {
	// Shrink long labels to fit rather than clipping them at the key edges.
	const size = Math.min(maxSize, Math.floor(MAX_TEXT_WIDTH / (Math.max(1, value.length) * GLYPH_WIDTH)));
	return `<text x="${KEY_SIZE / 2}" y="${y}" fill="${COLORS.text}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="middle">${escapeXml(value)}</text>`;
}

/** A red outline around the key; a corner badge would collide with the top label. */
function errorBadge(): string {
	return `<rect x="3" y="3" width="138" height="138" rx="14" fill="none" stroke="${ERROR_COLOR}" stroke-width="6"/>`;
}

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Shorten a label so it fits on a key. */
export function truncate(value: string | undefined, max = MAX_LABEL): string {
	return (value ?? "").trim().slice(0, max);
}

/** Compact countdown, e.g. 205s -> "3m25s", 9s -> "9s". */
export function formatCountdown(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1_000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
