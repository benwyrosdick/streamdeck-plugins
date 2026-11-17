import { type Action, action } from "@elgato/streamdeck";

import { classifyRun, normalizeRepo, type RunState } from "../github/queries";
import { type IconName, truncate, type View } from "../render";
import { type GitHub, GitHubAction, rateLimitedView, showAlert } from "./github-action";

export type CiStatusSettings = {
	/** Short name shown on the key; defaults to the workflow name. */
	name?: string;
	repo?: string;
	/** A workflow name (`CI`) or file (`ci.yml`); blank for any workflow. */
	workflow?: string;
	/** Blank for any branch. */
	branch?: string;
};

const ICONS: Record<RunState, IconName> = {
	success: "ciSuccess",
	failure: "ciFailure",
	running: "ciRunning",
	queued: "ciQueued",
	neutral: "ciNeutral",
};

/** How often the in-progress spinner advances, and by how much. */
export const SPIN_INTERVAL_MS = 100;
export const SPIN_STEP_DEGREES = 36;

/**
 * The status of the latest GitHub Actions run for a repo, optionally pinned
 * to a workflow and/or branch. While a run is in progress the icon spins and
 * live step progress is shown. Pressing opens the run (or the repo's Actions
 * page).
 */
@action({ UUID: "com.benwyrosdick.github.ci-status" })
export class CiStatus extends GitHubAction<CiStatusSettings> {
	#frame = 0;

	constructor(github: GitHub) {
		super(github);
		// Keys can't play GIFs from setImage, so the spinner is animated by
		// re-rendering with a new rotation. Only running keys change between
		// frames; the render dedup skips everything else.
		setInterval(() => {
			if (this.actions.length > 0) {
				this.#frame = (this.#frame + 1) % (360 / SPIN_STEP_DEGREES);
				this.renderAll();
			}
		}, SPIN_INTERVAL_MS);
	}

	protected override view(settings: CiStatusSettings): View {
		const name = truncate(settings.name);
		const repo = normalizeRepo(settings.repo);
		if (!repo) {
			return { icon: "ciNeutral", top: name || "CI", error: true };
		}

		const { store } = this.github;
		const until = store.rateLimitedUntil();
		if (until !== undefined) {
			return rateLimitedView(until);
		}

		const run = store.run(repo, settings.workflow?.trim(), settings.branch?.trim());
		if (run === undefined) {
			// Not loaded yet, unless gh isn't signed in.
			return store.authenticated() === false
				? { center: "auth", top: name || "CI", error: true }
				: { icon: "ciQueued", top: name || "CI" };
		}
		if (run === null) {
			return { icon: "ciNeutral", top: name || "no runs" };
		}

		const state = classifyRun(run);
		const view: View = { icon: ICONS[state], top: name || truncate(run.workflowName || settings.branch) || "CI" };
		if (state === "running") {
			view.rotation = this.#frame * SPIN_STEP_DEGREES;
			const progress = store.runProgress(repo, run.databaseId);
			if (progress) {
				view.bottom = `${progress.completed} / ${progress.total}`;
				view.bottomSmall = true;
			}
		}
		return view;
	}

	protected override async press(action: Action<CiStatusSettings>, settings: CiStatusSettings): Promise<void> {
		const repo = normalizeRepo(settings.repo);
		if (!repo) {
			await showAlert(action);
			return;
		}
		const workflow = settings.workflow?.trim();
		const branch = settings.branch?.trim();
		const url = this.github.store.run(repo, workflow, branch)?.url || `https://github.com/${repo}/actions`;
		this.github.store.invalidateRun(repo, workflow, branch);
		await this.open(action, url);
	}
}
