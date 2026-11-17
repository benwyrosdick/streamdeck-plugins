import { describe, expect, it } from "vitest";

import {
	classifyRun,
	issueQuery,
	normalizeRepo,
	NOTIFICATION_FILTERS,
	notificationFilter,
	notificationsUrl,
	prQuery,
	searchUrl,
} from "../src/github/queries";

describe("normalizeRepo", () => {
	it("accepts owner/name, trimming whitespace and slashes", () => {
		expect(normalizeRepo(" /owner/name/ ")).toBe("owner/name");
	});

	it("rejects anything else", () => {
		expect(normalizeRepo("")).toBe("");
		expect(normalizeRepo(undefined)).toBe("");
		expect(normalizeRepo("owner")).toBe("");
		expect(normalizeRepo("a/b/c")).toBe("");
		expect(normalizeRepo("owner/")).toBe("");
	});
});

describe("prQuery", () => {
	it("defaults to open PRs", () => {
		expect(prQuery({ repo: "o/r" })).toBe("repo:o/r type:pr state:open");
	});

	it("maps every filter onto search qualifiers", () => {
		expect(
			prQuery({ repo: "o/r", state: "merged", author: "not_user", user: "@bot", approval: "changes_requested", labels: "api, needs review,", extra: "draft:false" }),
		).toBe('repo:o/r type:pr is:merged -author:bot review:changes_requested label:"api","needs review" draft:false');
	});

	it("handles the author variants", () => {
		expect(prQuery({ repo: "o/r", state: "all", author: "me" })).toBe("repo:o/r type:pr author:@me");
		expect(prQuery({ repo: "o/r", state: "all", author: "not_me" })).toBe("repo:o/r type:pr -author:@me");
		expect(prQuery({ repo: "o/r", state: "all", author: "user", user: "octocat" })).toBe("repo:o/r type:pr author:octocat");
		// A specific-user filter without a user is ignored rather than broken.
		expect(prQuery({ repo: "o/r", state: "all", author: "user" })).toBe("repo:o/r type:pr");
	});
});

describe("issueQuery", () => {
	it("defaults to open issues", () => {
		expect(issueQuery({ repo: "o/r" })).toBe("repo:o/r type:issue state:open");
	});

	it("maps assignee filters", () => {
		expect(issueQuery({ repo: "o/r", state: "closed", assignee: "none" })).toBe("repo:o/r type:issue state:closed no:assignee");
		expect(issueQuery({ repo: "o/r", state: "all", assignee: "me" })).toBe("repo:o/r type:issue assignee:@me");
		expect(issueQuery({ repo: "o/r", state: "all", assignee: "not_me", labels: "bug" })).toBe('repo:o/r type:issue -assignee:@me label:"bug"');
	});
});

describe("searchUrl", () => {
	it("encodes the query", () => {
		expect(searchUrl("repo:o/r type:pr", "pullrequests")).toBe("https://github.com/search?q=repo%3Ao%2Fr%20type%3Apr&type=pullrequests");
	});
});

describe("notifications", () => {
	it("falls back to all for unknown filters", () => {
		expect(notificationFilter("bogus")).toBe(NOTIFICATION_FILTERS.all);
		expect(notificationFilter("toString")).toBe(NOTIFICATION_FILTERS.all);
		expect(notificationFilter("review_requested").reason).toBe("review_requested");
	});

	it("builds inbox URLs", () => {
		expect(notificationsUrl("", NOTIFICATION_FILTERS.all)).toBe("https://github.com/notifications");
		expect(notificationsUrl("o/r", NOTIFICATION_FILTERS.team_mentioned)).toBe(
			"https://github.com/notifications?query=repo%3Ao%2Fr%20reason%3Ateam-mention",
		);
	});
});

describe("classifyRun", () => {
	it("collapses status and conclusion", () => {
		expect(classifyRun({ status: "in_progress" })).toBe("running");
		expect(classifyRun({ status: "queued" })).toBe("queued");
		expect(classifyRun({ status: "waiting" })).toBe("queued");
		expect(classifyRun({ status: "completed", conclusion: "success" })).toBe("success");
		expect(classifyRun({ status: "completed", conclusion: "timed_out" })).toBe("failure");
		expect(classifyRun({ status: "completed", conclusion: "cancelled" })).toBe("neutral");
	});
});
