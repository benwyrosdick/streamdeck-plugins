import streamDeck from "@elgato/streamdeck";

import { CiStatus } from "./actions/ci-status";
import type { GitHub } from "./actions/github-action";
import { IssueCount } from "./actions/issue-count";
import { NotificationCount } from "./actions/notification-count";
import { PrCount } from "./actions/pr-count";
import { GhCli } from "./github/cli";
import { GitHubStore } from "./github/store";

streamDeck.logger.setLevel("info");

const cli = new GhCli({
	onError: (args, { stderr }) => streamDeck.logger.warn(`gh ${args.slice(0, 3).join(" ")} failed: ${stderr.trim().slice(0, 200)}`),
});
const github: GitHub = {
	store: new GitHubStore(cli),
	openUrl: (url) => streamDeck.system.openUrl(url),
};

streamDeck.actions.registerAction(new PrCount(github));
streamDeck.actions.registerAction(new IssueCount(github));
streamDeck.actions.registerAction(new CiStatus(github));
streamDeck.actions.registerAction(new NotificationCount(github));

// Re-render visible keys every second: this picks up values as their cache
// windows expire (each key's data is refreshed in the background) and keeps
// the rate-limit countdown ticking. The store's cache means GitHub is queried
// at most once per window per unique filter, however many keys are showing.
github.store.startTicking(1_000, () => streamDeck.actions.length > 0);

streamDeck.connect();
