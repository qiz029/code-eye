/**
 * A walkthrough is an ordered list of stops the agent wants the user to
 * look at. Each stop points into the review data (commit + file + line)
 * and carries the context the user needs to evaluate it.
 */
export interface WalkthroughStop {
	/** Short headline, e.g. "Retry logic swallows errors". */
	title: string;
	/** Why this needs attention; context the user needs. */
	detail: string;
	/** Short commit sha; undefined/null/"" means uncommitted changes. */
	sha?: string | null;
	/** File path within that commit's diff. */
	file?: string;
	/** Line number in the new version of the file. */
	line?: number;
	/** Optional categorization, shown as a tag. */
	kind?: string;
}
