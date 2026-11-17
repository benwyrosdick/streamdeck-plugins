import { describe, expect, it, vi } from "vitest";

// The SDK connects to Stream Deck on use; stub the pieces the actions touch.
vi.mock("@elgato/streamdeck", () => ({
	default: { logger: { error: vi.fn() } },
	action: () => (target: unknown) => target,
	SingletonAction: class {
		get actions() {
			return [];
		}
	},
}));

import { CiStatus, type CiStatusSettings, SPIN_STEP_DEGREES } from "../src/actions/ci-status";
import type { GitHub } from "../src/actions/github-action";
import { IssueCount } from "../src/actions/issue-count";
import { NotificationCount, type NotificationCountSettings } from "../src/actions/notification-count";
import { PrCount, type PrCountSettings } from "../src/actions/pr-count";
import type { StepProgress, WorkflowRun } from "../src/github/cli";
import { COLORS, type View } from "../src/render";

type FakeState = {
	count?: number;
	notifications?: number;
	run?: WorkflowRun | null;
	progress?: StepProgress;
	authenticated?: boolean;
	rateLimitedUntil?: number;
};

function fakeGitHub(state: FakeState = {}) {
	const store = {
		subscribe: vi.fn(),
		count: vi.fn(() => state.count),
		notificationCount: vi.fn(() => state.notifications),
		run: vi.fn(() => state.run),
		runProgress: vi.fn(() => state.progress),
		authenticated: vi.fn(() => state.authenticated),
		rateLimitedUntil: vi.fn(() => state.rateLimitedUntil),
		invalidateCount: vi.fn(),
		invalidateRun: vi.fn(),
		invalidateNotificationCount: vi.fn(),
	};
	return { store, openUrl: vi.fn(async () => {}) } as unknown as GitHub & { store: typeof store; openUrl: ReturnType<typeof vi.fn> };
}

// Expose the protected hooks for testing.
type Hooks<T> = {
	view(settings: T): View;
	press(action: unknown, settings: T): Promise<void>;
	render(action: unknown): Promise<void>;
};

function hooks<T>(instance: object): Hooks<T> {
	const action = instance as unknown as Hooks<T>;
	action.render = async () => {};
	return action;
}

const fakeKey = () => ({ id: "k", isKey: () => true, isDial: () => false, showAlert: vi.fn(async () => {}) });

describe("PrCount", () => {
	it("flags a missing repo", () => {
		const action = hooks<PrCountSettings>(new PrCount(fakeGitHub()));
		expect(action.view({ repo: "nope" })).toEqual({ icon: "pr", top: "PRs", bottom: "—", error: true });
	});

	it("shows loading, then auth, then the count", () => {
		const github = fakeGitHub();
		const action = hooks<PrCountSettings>(new PrCount(github));
		expect(action.view({ repo: "o/r", name: "Mine" })).toMatchObject({ top: "Mine", bottom: "…" });
		expect(action.view({ repo: "o/r" }).error).toBeUndefined();

		const unauthenticated = hooks<PrCountSettings>(new PrCount(fakeGitHub({ authenticated: false })));
		expect(unauthenticated.view({ repo: "o/r" })).toMatchObject({ bottom: "auth", error: true });

		const counted = hooks<PrCountSettings>(new PrCount(fakeGitHub({ count: 3 })));
		expect(counted.view({ repo: "o/r" })).toEqual({ icon: "pr", top: "PRs", bottom: "3", background: COLORS.highlight });
		const zero = hooks<PrCountSettings>(new PrCount(fakeGitHub({ count: 0 })));
		expect(zero.view({ repo: "o/r" }).background).toBeUndefined();
	});

	it("shows the rate-limit countdown", () => {
		const action = hooks<PrCountSettings>(new PrCount(fakeGitHub({ rateLimitedUntil: Date.now() + 65_000 })));
		expect(action.view({ repo: "o/r" })).toMatchObject({ top: "rate limit", background: COLORS.rateLimited });
	});

	it("opens the search and refreshes on press", async () => {
		const github = fakeGitHub();
		const action = hooks<PrCountSettings>(new PrCount(github));
		await action.press(fakeKey(), { repo: "o/r", author: "me" });
		expect(github.store.invalidateCount).toHaveBeenCalledWith("repo:o/r type:pr state:open author:@me");
		expect(github.openUrl).toHaveBeenCalledWith(expect.stringContaining("&type=pullrequests"));
	});

	it("alerts instead of opening when unconfigured", async () => {
		const github = fakeGitHub();
		const key = fakeKey();
		await hooks<PrCountSettings>(new PrCount(github)).press(key, {});
		expect(key.showAlert).toHaveBeenCalled();
		expect(github.openUrl).not.toHaveBeenCalled();
	});
});

describe("IssueCount", () => {
	it("opens the issue search", async () => {
		const github = fakeGitHub({ count: 2 });
		const action = hooks(new IssueCount(github));
		expect(action.view({ repo: "o/r" })).toMatchObject({ icon: "issue", top: "Issues", bottom: "2" });
		await action.press(fakeKey(), { repo: "o/r" });
		expect(github.openUrl).toHaveBeenCalledWith(expect.stringContaining("&type=issues"));
	});
});

describe("NotificationCount", () => {
	it("works without a repo and passes the filter through", async () => {
		const github = fakeGitHub({ notifications: 4 });
		const action = hooks<NotificationCountSettings>(new NotificationCount(github));
		expect(action.view({ filter: "participating" })).toMatchObject({ icon: "inbox", top: "Inbox", bottom: "4" });
		expect(github.store.notificationCount).toHaveBeenCalledWith("", true, "");

		await action.press(fakeKey(), { repo: "o/r", filter: "assigned" });
		expect(github.store.invalidateNotificationCount).toHaveBeenCalledWith("o/r", false, "assign");
		expect(github.openUrl).toHaveBeenCalledWith("https://github.com/notifications?query=repo%3Ao%2Fr%20reason%3Aassign");
	});
});

describe("CiStatus", () => {
	it("shows queued while loading and auth when signed out", () => {
		expect(hooks<CiStatusSettings>(new CiStatus(fakeGitHub())).view({ repo: "o/r" })).toEqual({ icon: "ciQueued", top: "CI" });
		expect(hooks<CiStatusSettings>(new CiStatus(fakeGitHub({ authenticated: false }))).view({ repo: "o/r" })).toEqual({
			center: "auth",
			top: "CI",
			error: true,
		});
	});

	it("distinguishes no runs", () => {
		expect(hooks<CiStatusSettings>(new CiStatus(fakeGitHub({ run: null }))).view({ repo: "o/r" })).toEqual({ icon: "ciNeutral", top: "no runs" });
	});

	it("labels with the workflow name and shows progress while running", () => {
		const github = fakeGitHub({ run: { status: "in_progress", workflowName: "Build", databaseId: 7 }, progress: { completed: 4, total: 9 } });
		const view = hooks<CiStatusSettings>(new CiStatus(github)).view({ repo: "o/r", branch: " main " });
		expect(view).toMatchObject({ icon: "ciRunning", top: "Build", bottom: "4 / 9", bottomSmall: true });
		expect(view.rotation! % SPIN_STEP_DEGREES).toBe(0);
		expect(github.store.run).toHaveBeenCalledWith("o/r", undefined, "main");
		expect(github.store.runProgress).toHaveBeenCalledWith("o/r", 7);
	});

	it("opens the run, or the Actions page when there isn't one", async () => {
		const withRun = fakeGitHub({ run: { status: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/1" } });
		await hooks<CiStatusSettings>(new CiStatus(withRun)).press(fakeKey(), { repo: "o/r" });
		expect(withRun.openUrl).toHaveBeenCalledWith("https://github.com/o/r/actions/runs/1");
		expect(withRun.store.invalidateRun).toHaveBeenCalledWith("o/r", undefined, undefined);

		const without = fakeGitHub({ run: null });
		await hooks<CiStatusSettings>(new CiStatus(without)).press(fakeKey(), { repo: "o/r" });
		expect(without.openUrl).toHaveBeenCalledWith("https://github.com/o/r/actions");
	});
});
