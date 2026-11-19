/** Thumbnail edge, matching the 144×144 key. */
const SIZE = 144;

/**
 * Small JPEG thumbnails of Foundry images, as data URLs the plugin can embed
 * in a key. Made in the browser (which can load the world's images), cached
 * by path. Images on another site without CORS headers can't be read back
 * from a canvas; those keys simply go without a picture.
 */
export class Thumbnails {
	/** @param {() => void} onReady called when a thumbnail finishes loading */
	constructor(onReady) {
		this.onReady = onReady;
		/** path → data URL, or null when it couldn't be made */
		this.cache = new Map();
		this.loading = new Set();
	}

	/** The thumbnail for `src` if it's ready; otherwise starts making it and returns undefined. */
	get(src) {
		if (!src) return undefined;
		if (this.cache.has(src)) return this.cache.get(src) ?? undefined;
		if (!this.loading.has(src)) {
			this.loading.add(src);
			this.#make(src).then((url) => {
				this.loading.delete(src);
				this.cache.set(src, url);
				if (url) this.onReady();
			});
		}
		return undefined;
	}

	async #make(src) {
		try {
			const image = new Image();
			image.crossOrigin = "anonymous";
			image.decoding = "async";
			image.src = src;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = SIZE;
			canvas.height = SIZE;
			const context = canvas.getContext("2d");
			// Cover the square, cropping the longer side; the plugin decides how to fit it on the key.
			const scale = Math.max(SIZE / image.naturalWidth, SIZE / image.naturalHeight) || 1;
			const width = image.naturalWidth * scale;
			const height = image.naturalHeight * scale;
			context.drawImage(image, (SIZE - width) / 2, (SIZE - height) / 2, width, height);
			// PNG keeps transparent icons (macros, tables) transparent; JPEG is smaller for pictures.
			const url = src.toLowerCase().endsWith(".svg") || src.toLowerCase().endsWith(".png") || src.toLowerCase().endsWith(".webp")
				? canvas.toDataURL("image/png")
				: canvas.toDataURL("image/jpeg", 0.82);
			return url.startsWith("data:image/") ? url : null;
		} catch {
			return null;
		}
	}
}
