import streamDeck from "@elgato/streamdeck";

import { Cpu } from "./actions/cpu";
import { Disk } from "./actions/disk";
import { Gpu } from "./actions/gpu";
import { Memory } from "./actions/memory";
import { Network } from "./actions/network";
import { Overview } from "./actions/overview";
import { SystemMonitor, systemSources } from "./monitor";

streamDeck.logger.setLevel("info");

const monitor = new SystemMonitor(systemSources());

streamDeck.actions.registerAction(new Cpu(monitor));
streamDeck.actions.registerAction(new Gpu(monitor));
streamDeck.actions.registerAction(new Memory(monitor));
streamDeck.actions.registerAction(new Disk(monitor));
streamDeck.actions.registerAction(new Network(monitor));
streamDeck.actions.registerAction(new Overview(monitor));

// Sample once a second while any key is showing. Each metric is only read
// while a visible key has asked for it, and keys re-render after every tick.
monitor.start(1_000, () => streamDeck.actions.length > 0);

// Stop the Windows GPU counter reader along with the plugin.
process.on("exit", () => monitor.dispose());

streamDeck.connect();
