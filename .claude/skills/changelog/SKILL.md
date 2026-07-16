---
name: changelog
description: "Prepare a new changelog release entry before merging a branch to master. Reads commits since master, infers the version bump (major/minor/patch) from commit content, updates CHANGELOG.md and the version in pyproject.toml, then creates a final changelog commit. USE FOR: release, changelog, version bump, bump version, new release, prepare release, merge to master. DO NOT USE FOR: creating feature branches, running tests, or deploying."
---

# Changelog Release Skill

Prepare a changelog release entry for the current branch before merging to master.

## Workflow

### Step 1 – Discover commits since master

**Important:** All git commands must run from the root of the repository where this skill is installed. If the current working directory is a different repo, switch to the correct one before proceeding.

Run the following to get all commits on this branch not yet on master:

```bash
git log master..HEAD --oneline
```

If the output is empty, stop and tell the user there are no commits ahead of master — nothing to release.

### Step 2 – Infer the version bump type

Read the full diff and commit messages carefully:

```bash
git log master..HEAD --pretty=format:"%s%n%b"
```

**First, filter out intra-branch noise.** Before deciding the bump type or drafting bullets, identify commits that have no net effect on master:

- A commit that fixes a mistake introduced by an earlier commit *on this same branch* (e.g. "fix path added in previous commit", "add missing import forgotten earlier", "fix CI variable introduced in this branch"). Both the original mistake and its fix cancel out — omit both from the changelog and do not let them influence the bump type.
- A feature that was added and then fully reverted within the branch — omit both.
- Use the commit message wording and the diff context to judge: if a `fix:` commit's diff only touches code that didn't exist on master before this branch, it is intra-branch noise.

Only the **net changes** relative to master determine the bump type and the changelog content.

Apply these rules to decide the bump type:

| Signal in commits | Bump |
|---|---|
| Breaking change, API removal, major refactor that changes public interface | **major** |
| New feature, new public function/class/command, new pipeline, new entity | **minor** |
| Bug fix, documentation, refactor with no new features, dependency update | **patch** |

When in doubt, default to **patch**.

### Step 3 – Check for a previous changelog run on this branch

Run:

```bash
git log master..HEAD --oneline --grep="bump version"
```

If this returns one or more `chore: bump version to X.Y.Z` commits, it means `/changelog` was already run on this branch and produced intermediate version entries that were never merged to master. Those intermediate entries must **not** appear as separate releases.

In that case:
- Identify all intermediate version entries that appear in `CHANGELOG.md` above the last master version (i.e. every `## [X.Y.Z]` block that was added by commits on this branch).
- Treat all their bullets as part of the current changelog draft — fold them in along with the new commits being processed now.
- Remove every intermediate `## [X.Y.Z]` block from `CHANGELOG.md` so only one new entry is written for this branch.
- Base the version number on the **highest bump type** across all commits (including those already captured in the intermediate entries).

If no previous bump commit exists, proceed normally.

### Step 4 – Read the current version

Read `pyproject.toml` and extract the current `version = "X.Y.Z"` line.

Compute the new version by applying the bump from Step 2 (and Step 3 if intermediate entries were folded in):
- **major**: increment X, reset Y and Z to 0
- **minor**: increment Y, reset Z to 0
- **patch**: increment Z

### Step 5 – Draft and apply the changelog entry

The changelog follows two standards:
- **[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)** — entry structure, section names, and writing style
- **[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)** — version bump rules

Read the existing `CHANGELOG.md` to match the established writing style.

Draft the new entry based on the **net changes** identified in Step 2. Rules:
- Only include sections (`### Added`, `### Changed`, `### Fixed`, `### Removed`) that have at least one bullet.
- Write bullets in the same terse style as existing entries — no fluff, no "this commit", no author names.
- Do not mention internal implementation details unless they are user-visible.
- Omit any changelog, version bump, or docs-only commits from the bullet list.
- Omit intra-branch noise identified in Step 2 — these have no impact on master and do not belong in the changelog.

Proceed directly to updating the files and creating the commit — do not ask for confirmation first.

### Step 6 – Update CHANGELOG.md

Insert the new entry directly after the `# Changelog` header block (after the preamble lines that end before the first `## [` entry). The new entry format is:

```markdown
## [X.Y.Z]

### Added

- ...

### Fixed

- ...
```

### Step 7 – Update version in pyproject.toml

Replace the `version = "OLD"` line with `version = "NEW"`.

Verify the edit looks correct before committing.

### Step 8 – Create the changelog commit

Stage only the two changed files and create the commit:

```bash
git add CHANGELOG.md pyproject.toml
git commit -m "chore: bump version to X.Y.Z and update CHANGELOG"
```

Do not push. Tell the user the commit was created, show the changelog entry that was written, and confirm the branch is ready to merge.

## Error handling

- If `pyproject.toml` is not found, tell the user and stop.
- If `CHANGELOG.md` is not found, offer to create it with a standard header before proceeding.
- Never amend existing commits — always create a new one.
