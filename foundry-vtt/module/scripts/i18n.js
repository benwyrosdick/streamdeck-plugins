/** Localize `SDBRIDGE.<key>`, formatting `{placeholders}` from `data`. */
export const t = (key, data) => (data ? game.i18n.format(`SDBRIDGE.${key}`, data) : game.i18n.localize(`SDBRIDGE.${key}`));
