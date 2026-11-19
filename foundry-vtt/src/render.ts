/**
 * Key artwork, generated as SVG on the 144×144 key canvas from a {@link View}
 * the Foundry module describes. Only features Stream Deck's SVG renderer
 * handles reliably are used: shapes, paths, linear gradients, opacity, and
 * raster `<image>` data URLs.
 */
import { type ActionKind, BORDERS, type Border, GLYPHS, type Glyph, type View } from "./bridge/protocol";

const SIZE = 144;
const FONT = "'Segoe UI', 'SF Pro Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const WHITE = "#ffffff";

/** Each action's background, so keys are recognisable at a glance. */
export const BACKGROUNDS: Record<ActionKind, string> = {
	macro: "#4b2d73",
	scene: "#1f5a41",
	token: "#2a2420",
	combat: "#7a2424",
	playlist: "#174e78",
	system: "#3a414c",
};

export const BORDER_COLORS: Record<Border, string> = {
	active: "#3fbf5f",
	viewed: "#4a8fe0",
	current: "#ffcc33",
	selected: "#ff8c1a",
	alert: "#e5534b",
};

/** Largest thumbnail accepted from the module (base64 characters). */
const MAX_IMAGE = 400_000;
const MAX_TEXT = 40;

/**
 * A view as received over the wire, cleaned up: unknown glyphs and borders
 * dropped, text shortened, and only small base64 raster images kept, so a
 * misbehaving module can't inject markup or bloat keys.
 */
export function sanitizeView(raw: unknown): View {
	const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined);
	const view: View = {};
	if (GLYPHS.includes(v.glyph as Glyph)) view.glyph = v.glyph as Glyph;
	if (typeof v.image === "string" && v.image.length <= MAX_IMAGE && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v.image)) {
		view.image = v.image;
	}
	if (v.fit === "contain" || v.fit === "cover") view.fit = v.fit;
	for (const key of ["title", "big", "subtitle", "badge"] as const) {
		const value = text(v[key]);
		if (value) view[key] = key === "badge" ? value.slice(0, 4) : value;
	}
	const bar = v.bar as { value?: unknown; max?: unknown } | undefined;
	if (bar && typeof bar.value === "number" && typeof bar.max === "number" && bar.max > 0) {
		view.bar = { value: bar.value, max: bar.max };
	}
	if (BORDERS.includes(v.border as Border)) view.border = v.border as Border;
	if (v.dim === true) view.dim = true;
	return view;
}

/** The SVG markup for a key of action `kind` showing `view`. */
export function keySvg(kind: ActionKind, view: View): string {
	const parts: string[] = [`<rect width="${SIZE}" height="${SIZE}" fill="${BACKGROUNDS[kind]}"/>`];
	const hasTitle = !!view.title;

	if (view.image) {
		const cover = view.fit !== "contain";
		const box = cover ? { x: 0, y: 0, w: SIZE, h: SIZE } : { x: 14, y: 10, w: 116, h: hasTitle ? 92 : 116 };
		parts.push(
			`<image x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" preserveAspectRatio="xMidYMid ${cover ? "slice" : "meet"}" href="${view.image}" xlink:href="${view.image}"/>`,
		);
		if (cover && hasTitle) {
			// Darken the bottom so the title stays readable over any picture.
			parts.push(
				`<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></linearGradient></defs>`,
				`<rect y="78" width="${SIZE}" height="66" fill="url(#shade)"/>`,
			);
		}
	} else if (view.big) {
		parts.push(text(view.big, SIZE / 2, view.subtitle ? 74 : 84, 44, WHITE, 800));
		if (view.subtitle) parts.push(text(view.subtitle, SIZE / 2, 98, 18, WHITE, 600, 0.85));
	} else {
		const glyph = view.glyph ?? "unknown";
		const size = hasTitle ? 72 : 96;
		const x = (SIZE - size) / 2;
		const y = hasTitle ? 16 : x;
		parts.push(`<g transform="translate(${x} ${y}) scale(${size / 256})">${glyphShapes(glyph, WHITE)}</g>`);
	}

	if (view.bar) {
		const fraction = Math.min(1, Math.max(0, view.bar.value / view.bar.max));
		const color = fraction > 0.5 ? "#3fbf5f" : fraction > 0.25 ? "#ffcc33" : "#e5534b";
		parts.push(
			`<rect x="10" y="${hasTitle ? 102 : 124}" width="124" height="10" rx="5" fill="#000" fill-opacity="0.55"/>`,
			`<rect x="10" y="${hasTitle ? 102 : 124}" width="${Math.max(10, 124 * fraction).toFixed(1)}" height="10" rx="5" fill="${color}"/>`,
		);
	}
	if (view.title) {
		parts.push(text(view.title, SIZE / 2, 132, 22, WHITE, 700));
	}
	if (view.badge) {
		const width = Math.max(28, view.badge.length * 13 + 12);
		parts.push(
			`<rect x="${SIZE - width - 6}" y="6" width="${width}" height="26" rx="13" fill="#000" fill-opacity="0.6"/>`,
			text(view.badge, SIZE - 6 - width / 2, 25, 17, WHITE, 700),
		);
	}
	if (view.dim) {
		parts.push(`<rect width="${SIZE}" height="${SIZE}" fill="#000" fill-opacity="0.55"/>`);
	}
	if (view.border) {
		parts.push(`<rect x="3.5" y="3.5" width="137" height="137" rx="16" fill="none" stroke="${BORDER_COLORS[view.border]}" stroke-width="7"/>`);
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${parts.join("")}</svg>`;
}

/** `keySvg` as a data URL suitable for `setImage` / `setFeedback`. */
export function keyImage(kind: ActionKind, view: View): string {
	return `data:image/svg+xml;base64,${Buffer.from(keySvg(kind, view)).toString("base64")}`;
}

/** Line icons on a 256×256 grid. */
export function glyphShapes(glyph: Glyph, color: string): string {
	const stroke = (width: number) => `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`;
	const fill = `fill="${color}"`;
	switch (glyph) {
		case "macro":
			return `<path d="M148 24L60 144H124L108 232L196 112H132Z" ${stroke(18)}/>`;
		case "scene":
			return `<path d="M32 64L96 40L160 64L224 40V192L160 216L96 192L32 216Z M96 40V192 M160 64V216" ${stroke(18)}/>`;
		case "token":
			return [`<circle cx="128" cy="92" r="44" ${stroke(18)}/>`, `<path d="M48 220Q48 152 128 152Q208 152 208 220" ${stroke(18)}/>`].join("");
		case "combat":
			// Two crossed swords: blade, guard, grip and pommel each.
			return [
				`<path d="M40 40L164 164 M132 180L180 132 M164 164L204 204" ${stroke(18)}/>`,
				`<path d="M216 40L92 164 M76 132L124 180 M92 164L52 204" ${stroke(18)}/>`,
				`<circle cx="212" cy="212" r="12" fill="${color}"/>`,
				`<circle cx="44" cy="212" r="12" fill="${color}"/>`,
			].join("");
		case "next":
			return `<path d="M56 56L144 128L56 200Z M200 56V200" ${stroke(20)}/>`;
		case "previous":
			return `<path d="M200 56L112 128L200 200Z M56 56V200" ${stroke(20)}/>`;
		case "nextRound":
			return `<path d="M40 64L120 128L40 192Z M136 64L216 128L136 192Z" ${stroke(20)}/>`;
		case "previousRound":
			return `<path d="M216 64L136 128L216 192Z M120 64L40 128L120 192Z" ${stroke(20)}/>`;
		case "start":
			return `<path d="M72 48L200 128L72 208Z" ${stroke(20)}/>`;
		case "end":
			return `<path d="M64 232V32 M64 40H200L176 88L200 136H64" ${stroke(20)}/>`;
		case "dice":
			return [`<path d="M128 24L218 76V180L128 232L38 180V76Z" ${stroke(16)}/>`, `<path d="M128 72L176 156H80Z M128 24V72 M38 76L80 156 M218 76L176 156 M80 156L38 180 M176 156L218 180 M80 156L128 232L176 156" ${stroke(12)}/>`].join("");
		case "music":
			return [`<path d="M96 184V56L208 32V160" ${stroke(18)}/>`, `<circle cx="72" cy="184" r="28" ${fill}/>`, `<circle cx="184" cy="160" r="28" ${fill}/>`].join("");
		case "sound":
			return `<path d="M40 100H88L144 52V204L88 156H40Z M176 92Q200 128 176 164 M200 64Q248 128 200 192" ${stroke(18)}/>`;
		case "stop":
			return `<rect x="56" y="56" width="144" height="144" rx="16" ${fill}/>`;
		case "pause":
			return `<rect x="60" y="48" width="44" height="160" rx="10" ${fill}/><rect x="152" y="48" width="44" height="160" rx="10" ${fill}/>`;
		case "play":
			return `<path d="M72 44L212 128L72 212Z" ${fill}/>`;
		case "table":
			return `<path d="M72 40H200V184Q200 216 168 216H56 M72 40Q40 40 40 72V88H72 M72 40V184Q72 216 40 216H168 M104 88H168 M104 128H168" ${stroke(16)}/>`;
		case "chat":
			return `<path d="M40 56H216V172H112L64 216V172H40Z" ${stroke(18)}/>`;
		case "moon":
			return `<path d="M168 40A92 92 0 1 0 216 168A72 72 0 1 1 168 40Z" ${stroke(18)}/>`;
		case "sun":
			return [
				`<circle cx="128" cy="128" r="44" ${stroke(18)}/>`,
				Array.from({ length: 8 }, (_, i) => {
					const a = (i * Math.PI) / 4;
					const p = (r: number) => `${(128 + r * Math.cos(a)).toFixed(1)} ${(128 + r * Math.sin(a)).toFixed(1)}`;
					return `<path d="M${p(76)}L${p(104)}" ${stroke(18)}/>`;
				}).join(""),
			].join("");
		case "sidebar":
			return `<rect x="32" y="48" width="192" height="160" rx="16" ${stroke(16)}/><path d="M152 48V208 M176 88H200 M176 120H200 M176 152H200" ${stroke(14)}/>`;
		default:
			return `<path d="M88 92Q88 52 128 52Q168 52 168 88Q168 112 128 128V156 M128 196V200" ${stroke(22)}/>`;
	}
}

/** Average glyph width relative to font size, for a bold sans-serif. */
const GLYPH_WIDTH = 0.58;

function text(value: string, x: number, y: number, maxSize: number, color: string, weight: number, opacity = 1): string {
	const size = Math.max(10, Math.min(maxSize, Math.floor(128 / (Math.max(1, [...value].length) * GLYPH_WIDTH))));
	const fade = opacity < 1 ? ` fill-opacity="${opacity}"` : "";
	return `<text x="${x}" y="${y}" fill="${color}"${fade} font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="middle">${escapeXml(value)}</text>`;
}

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
