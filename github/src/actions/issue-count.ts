import { type Action, action } from "@elgato/streamdeck";

import { type IssueFilter, issueQuery, normalizeRepo, searchUrl } from "../github/queries";
import { truncate, type View } from "../render";
import { countView, GitHubAction, pendingView, rateLimitedView, showAlert } from "./github-action";

export type IssueCountSettings = IssueFilter & {
	/** Short name shown on the key. */
	name?: string;
};

/** A live count of issues matching a filter; pressing opens the equivalent search. */
@action({ UUID: "com.benwyrosdick.github.issue-count" })
export class IssueCount extends GitHubAction<IssueCountSettings> {
	protected override view(settings: IssueCountSettings): View {
		const base: View = { icon: "issue", top: truncate(settings.name) || "Issues" };
		if (!normalizeRepo(settings.repo)) {
			return { ...base, bottom: "—", error: true };
		}

		const { store } = this.github;
		const until = store.rateLimitedUntil();
		if (until !== undefined) {
			return rateLimitedView(until);
		}

		const count = store.count(issueQuery(settings));
		return count === undefined ? pendingView(base, store.authenticated()) : countView(base, count);
	}

	protected override async press(action: Action<IssueCountSettings>, settings: IssueCountSettings): Promise<void> {
		if (!normalizeRepo(settings.repo)) {
			await showAlert(action);
			return;
		}
		const query = issueQuery(settings);
		this.github.store.invalidateCount(query);
		await this.open(action, searchUrl(query, "issues"));
	}
}
