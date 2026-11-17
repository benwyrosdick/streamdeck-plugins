import { type Action, action } from "@elgato/streamdeck";

import { type NotificationFilterName, normalizeRepo, notificationFilter, notificationsUrl } from "../github/queries";
import { truncate, type View } from "../render";
import { countView, GitHubAction, pendingView, rateLimitedView } from "./github-action";

export type NotificationCountSettings = {
	/** Short name shown on the key. */
	name?: string;
	/** Optional `owner/name`; blank counts across every repo. */
	repo?: string;
	filter?: NotificationFilterName;
};

/**
 * A live count of unread notifications, optionally scoped to one repo and to
 * one of the inbox's filters. Pressing opens the matching inbox view.
 */
@action({ UUID: "com.benwyrosdick.github.notification-count" })
export class NotificationCount extends GitHubAction<NotificationCountSettings> {
	protected override view(settings: NotificationCountSettings): View {
		const base: View = { icon: "inbox", top: truncate(settings.name) || "Inbox" };

		const { store } = this.github;
		const until = store.rateLimitedUntil();
		if (until !== undefined) {
			return rateLimitedView(until);
		}

		const filter = notificationFilter(settings.filter);
		const count = store.notificationCount(normalizeRepo(settings.repo), filter.participating, filter.reason);
		return count === undefined ? pendingView(base, store.authenticated()) : countView(base, count);
	}

	protected override async press(action: Action<NotificationCountSettings>, settings: NotificationCountSettings): Promise<void> {
		const repo = normalizeRepo(settings.repo);
		const filter = notificationFilter(settings.filter);
		this.github.store.invalidateNotificationCount(repo, filter.participating, filter.reason);
		await this.open(action, notificationsUrl(repo, filter));
	}
}
