// Shared by every Foundry VTT key's inspector: the "Foundry connection" panel,
// plus showing only the fields that apply to the chosen function.
(function () {
	const pi = window.SDPIComponents;

	// Read-only, copyable values written by the plugin into the global settings.
	for (const [key, id] of [["pairingCode", "pairing-code"], ["status", "connection-status"]]) {
		pi.useGlobalSettings(key, (value) => {
			const el = document.getElementById(id);
			if (el) el[el.tagName === "INPUT" ? "value" : "textContent"] = value ?? "";
		});
	}
	document.getElementById("new-code")?.addEventListener("click", () => pi.streamDeckClient.send("sendToPlugin", { event: "newCode" }));
	document.getElementById("copy-code")?.addEventListener("click", () => {
		const input = document.getElementById("pairing-code");
		input.select();
		document.execCommand("copy");
	});

	// <sdpi-item data-show="fn:roll,chat"> is visible only while the "fn" setting is roll or chat.
	const rules = [...document.querySelectorAll("[data-show]")].map((el) => {
		const [setting, values] = el.dataset.show.split(":");
		return { el, setting, values: values.split(","), fallback: el.dataset.default };
	});
	const settings = {};
	const apply = () => {
		for (const { el, setting, values, fallback } of rules) {
			el.style.display = values.includes(settings[setting] ?? fallback) ? "" : "none";
		}
	};
	for (const setting of new Set(rules.map((r) => r.setting))) {
		pi.useSettings(setting, (value) => {
			settings[setting] = value;
			apply();
		});
	}
	apply();
})();
