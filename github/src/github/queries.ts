/**
 * Pure builders for GitHub search queries and URLs, shared by the actions and
 * free of any Stream Deck dependency so they're easy to test.
 */

import type { WorkflowRun } from "./cli";

export type AuthorFilter = "any" | "me" | "not_me" | "user" | "not_user";
export type ApprovalFilter = "any" | "none" | "approved" | "changes_requested" | "required";
export type AssigneeFilter = "any" | "me" | "not_me" | "none";
export type PrState = "open" | "closed" | "merged" | "all";
export type IssueState = "open" | "closed" | "all";

export type PrFilter = {
	repo?: string;
	author?: AuthorFilter;
	user?: string;
	approval?: ApprovalFilter;
	labels?: string;
	state?: PrState;
	extra?: string;
};

export type IssueFilter = {
	repo?: string;
	author?: AuthorFilter;
	user?: string;
	assignee?: AssigneeFilter;
	labels?: string;
	state?: IssueState;
	extra?: string;
};

/** A cleaned `owner/name`, or "" if `value` isn't a plausible repo. */
export function normalizeRepo(value: string | undefined): string {
	const repo = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
	const parts = repo.split("/");
	return parts.length === 2 && parts.every(Boolean) ? repo : "";
}

/** GitHub search query for pull requests matching `filter`. */
export function prQuery(filter: PrFilter): string {
	const terms = [`repo:${normalizeRepo(filter.repo)}`, "type:pr"];

	switch (filter.state ?? "open") {
		case "open":
			terms.push("state:open");
			break;
		case "closed":
			terms.push("state:closed");
			break;
		case "merged":
			terms.push("is:merged");
			break;
		// "all" -> no state qualifier
	}

	terms.push(...authorTerms(filter.author, filter.user));

	const approval = filter.approval ?? "any";
	if (approval !== "any") {
		terms.push(`review:${approval}`);
	}

	terms.push(...labelTerms(filter.labels), ...extraTerms(filter.extra));
	return terms.join(" ");
}

/** GitHub search query for issues matching `filter`. */
export function issueQuery(filter: IssueFilter): string {
	const terms = [`repo:${normalizeRepo(filter.repo)}`, "type:issue"];

	switch (filter.state ?? "open") {
		case "open":
			terms.push("state:open");
			break;
		case "closed":
			terms.push("state:closed");
			break;
		// "all" -> no state qualifier
	}

	terms.push(...authorTerms(filter.author, filter.user));

	switch (filter.assignee ?? "any") {
		case "me":
			terms.push("assignee:@me");
			break;
		case "not_me":
			terms.push("-assignee:@me");
			break;
		case "none":
			terms.push("no:assignee");
			break;
	}

	terms.push(...labelTerms(filter.labels), ...extraTerms(filter.extra));
	return terms.join(" ");
}

/** The github.com search page for `query`. */
export function searchUrl(query: string, type: "pullrequests" | "issues"): string {
	return `https://github.com/search?q=${encodeURIComponent(query)}&type=${type}`;
}

function authorTerms(author: AuthorFilter | undefined, user: string | undefined): string[] {
	const name = (user ?? "").trim().replace(/^@/, "");
	switch (author ?? "any") {
		case "me":
			return ["author:@me"];
		case "not_me":
			return ["-author:@me"];
		case "user":
			return name ? [`author:${name}`] : [];
		case "not_user":
			return name ? [`-author:${name}`] : [];
		default:
			return [];
	}
}

/**
 * Comma-separated labels are OR'd via a single qualifier with quoted values
 * (`label:"a","b"`). Separate `label:` qualifiers would AND them.
 */
function labelTerms(labels: string | undefined): string[] {
	const names = (labels ?? "")
		.split(",")
		.map((label) => label.trim())
		.filter(Boolean);
	return names.length ? [`label:${names.map((label) => `"${label}"`).join(",")}`] : [];
}

function extraTerms(extra: string | undefined): string[] {
	const raw = (extra ?? "").trim();
	return raw ? [raw] : [];
}

// ---------------------------------------------------------------------- //
// Notifications
// ---------------------------------------------------------------------- //

export type NotificationFilterName = "all" | "assigned" | "participating" | "mentioned" | "team_mentioned" | "review_requested";

export type NotificationFilter = {
	/** Notification `reason` selected client-side; "" for any. */
	reason: string;
	/** The REST API's native `participating` param. */
	participating: boolean;
	/** The inbox page's `query` qualifier used when opening in the browser. */
	query: string;
};

/**
 * Notification filters mirroring the inbox's Filters sidebar. The REST API
 * can't filter by reason, so those are selected client-side; "Participating"
 * uses the native participating param. Site queries hyphenate multi-word
 * reasons (team-mention) where the API uses underscores (team_mention).
 */
export const NOTIFICATION_FILTERS: Record<NotificationFilterName, NotificationFilter> = {
	all: { reason: "", participating: false, query: "" },
	assigned: { reason: "assign", participating: false, query: "reason:assign" },
	participating: { reason: "", participating: true, query: "reason:participating" },
	mentioned: { reason: "mention", participating: false, query: "reason:mention" },
	team_mentioned: { reason: "team_mention", participating: false, query: "reason:team-mention" },
	review_requested: { reason: "review_requested", participating: false, query: "reason:review-requested" },
};

export function notificationFilter(name: string | undefined): NotificationFilter {
	return Object.hasOwn(NOTIFICATION_FILTERS, name ?? "") ? NOTIFICATION_FILTERS[name as NotificationFilterName] : NOTIFICATION_FILTERS.all;
}

/**
 * The notifications inbox, filtered via a single `query` param combining repo
 * and reason qualifiers, e.g. `repo:owner/name reason:review-requested`.
 */
export function notificationsUrl(repo: string, filter: NotificationFilter): string {
	const parts = [repo ? `repo:${repo}` : "", filter.query].filter(Boolean);
	const base = "https://github.com/notifications";
	return parts.length ? `${base}?query=${encodeURIComponent(parts.join(" "))}` : base;
}

// ---------------------------------------------------------------------- //
// CI runs
// ---------------------------------------------------------------------- //

export type RunState = "success" | "failure" | "running" | "queued" | "neutral";

/** Collapse a run's status/conclusion into one of a handful of display states. */
export function classifyRun(run: WorkflowRun): RunState {
	const { status, conclusion } = run;
	if (status === "in_progress") {
		return "running";
	}
	if (status && status !== "completed") {
		// queued / waiting / requested / pending — not started running yet
		return "queued";
	}
	if (conclusion === "success") {
		return "success";
	}
	if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") {
		return "failure";
	}
	// cancelled / skipped / neutral / action_required / stale / unknown
	return "neutral";
}
