import { hmac, normalizeCode, randomHex, sameString } from "./sha256.js";

/** The protocol version this module speaks (see the plugin's src/bridge/protocol.ts). */
export const PROTOCOL = 1;

/** How long to wait for the plugin's challenge, then its proof. */
const AUTH_WAIT_MS = 5000;

/**
 * The module's end of the bridge: a WebSocket client to the Stream Deck
 * plugin, which listens on 127.0.0.1.
 *
 * Pairing is mutual. The plugin sends a challenge, this side answers with an
 * HMAC of it keyed by the pairing code, and then the plugin must prove it
 * knows the code too before any of its messages are acted on, so a different
 * program listening on the port can't drive Foundry.
 *
 * Reconnects with backoff (2s doubling to 30s), except after a wrong code
 * (until the code setting changes) or when another window took over.
 */
export class Bridge {
	/**
	 * @param {object} options
	 * @param {() => {host: string, port: number, code: string}} options.config
	 * @param {() => object} options.hello  extra fields for the hello (world, user…)
	 * @param {(message: object) => void} options.onMessage  messages after pairing
	 * @param {(state: string, detail?: string) => void} options.onState  "connected" | "disconnected" | "badCode" | "noCode" | "replaced"
	 * @param {typeof WebSocket} [options.WebSocket]
	 */
	constructor({ config, hello, onMessage, onState, WebSocket: Socket = globalThis.WebSocket }) {
		this.config = config;
		this.hello = hello;
		this.onMessage = onMessage;
		this.onState = onState;
		this.Socket = Socket;
		this.socket = null;
		this.connected = false;
		this.stopped = true;
		this.retry = 0;
		this.timer = null;
	}

	get url() {
		const { host, port } = this.config();
		const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
		return `ws://${bracketed}:${port}`;
	}

	start() {
		this.stopped = false;
		this.retry = 0;
		this.#open();
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.onclose = null;
			socket.onmessage = null;
			try {
				socket.close(1000, "stop");
			} catch {
				// Already closed.
			}
		}
		this.#setConnected(false);
	}

	/** Send to the plugin once paired; false otherwise. */
	send(message) {
		if (!this.connected || this.socket?.readyState !== this.Socket.OPEN) return false;
		this.socket.send(JSON.stringify(message));
		return true;
	}

	#open() {
		clearTimeout(this.timer);
		if (this.stopped) return;
		const code = normalizeCode(this.config().code);
		if (!code) {
			this.onState("noCode");
			return;
		}

		let socket;
		try {
			socket = new this.Socket(this.url);
		} catch {
			this.#schedule();
			return;
		}
		this.socket = socket;
		/** "challenge" → "proof" → "paired" */
		let phase = "challenge";
		let cnonce = "";
		const giveUp = () => {
			try {
				socket.close(4000, "timeout");
			} catch {
				// Already closed.
			}
		};
		let timer = setTimeout(giveUp, AUTH_WAIT_MS);

		socket.onmessage = (event) => {
			if (this.socket !== socket) return;
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (phase === "paired") {
				if (message.type === "replaced") {
					// Another Foundry window paired; stay out of its way.
					this.stopped = true;
					this.onState("replaced");
					return;
				}
				this.onMessage(message);
				return;
			}
			if (message.type === "rejected") {
				clearTimeout(timer);
				if (message.reason === "badCode") {
					// Wait for the user to fix the code; the setting change restarts the bridge.
					this.stopped = true;
					this.onState("badCode");
				}
				return;
			}
			if (phase === "challenge" && message.type === "challenge") {
				cnonce = randomHex(16);
				phase = "proof";
				socket.send(JSON.stringify({ type: "hello", protocol: PROTOCOL, auth: hmac(code, `client:${message.nonce}`), cnonce, ...this.hello() }));
				clearTimeout(timer);
				timer = setTimeout(giveUp, AUTH_WAIT_MS);
				return;
			}
			if (phase === "proof" && message.type === "welcome") {
				clearTimeout(timer);
				if (!sameString(message.proof, hmac(code, `server:${cnonce}`))) {
					// Whatever is on this port doesn't know the code: don't trust it.
					this.stopped = true;
					this.onState("badProof");
					giveUp();
					return;
				}
				phase = "paired";
				this.retry = 0;
				this.#setConnected(true);
			}
			// Anything else before pairing is ignored.
		};
		socket.onclose = () => {
			clearTimeout(timer);
			if (this.socket === socket) this.socket = null;
			this.#setConnected(false);
			this.#schedule();
		};
		socket.onerror = () => undefined;
	}

	#schedule() {
		if (this.stopped) return;
		const delay = Math.min(30_000, 2000 * 2 ** this.retry);
		this.retry = Math.min(this.retry + 1, 4);
		this.timer = setTimeout(() => this.#open(), delay);
	}

	#setConnected(value) {
		if (this.connected === value) return;
		this.connected = value;
		this.onState(value ? "connected" : "disconnected");
	}
}
