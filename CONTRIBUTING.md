# Contributing to TGPhotos

You can help with reproducible bug reports, translations, documentation, testing
or focused code changes. This guide explains how to prepare a contribution and
what reviewers need to assess it.

## Before you start

Search [issues](https://github.com/TGCloudApps/tgphotos/issues) and
[open pull requests](https://github.com/TGCloudApps/tgphotos/pulls) for existing work.
For a new feature, redesign, dependency, format change or large refactor, open an
issue first and agree on the scope with a maintainer. Small fixes and documentation
corrections can go directly to a pull request; a separate issue is optional.

A useful issue describes the task, expected behavior and actual behavior. For a
bug, include the app version, operating system, package format and reproduction
steps. Mention desktop, mobile or controller mode for interface problems.
Use a small example or recording when it makes the problem easier to reproduce.

## Fork and create a branch

1. Fork this repository on GitHub into your account.
2. Clone your fork and add the original repository as `upstream`.
3. Start a descriptive branch from the latest upstream `main`.

```sh
git clone https://github.com/YOUR_USERNAME/tgphotos.git
cd tgphotos
git remote add upstream https://github.com/TGCloudApps/tgphotos.git
git fetch upstream
git switch -c fix/restore-dialog-focus upstream/main
```

Replace `YOUR_USERNAME` and the example branch with your own values. Prefer
`fix/<description>`, `feat/<description>` or `docs/<description>` for contribution
branches. Keep your fork's `main` available for synchronization rather than doing
all your work on it.

These Git steps prepare a contribution, not a standalone native build environment.
Native changes are validated in the TGCloud development workspace. If you cannot
run a check, say so in the PR and provide precise reproduction and verification
steps. Do not describe unrun checks as passing. A maintainer must verify the
remaining behavior before the change is ready to merge.

## Keep the change reviewable

- Solve one problem per PR. Keep unrelated formatting, cleanup and dependency updates separate.
- Follow the surrounding TypeScript/React, Rust and Kotlin style. Format the files you changed without reformatting the whole repository.
- Reuse existing components, visual tokens and actions. Avoid separate implementations of the same behavior in each interface.
- Preserve the data format and existing user data. Discuss migrations and incompatible behavior before implementation.
- Handle errors through existing user-facing paths. Do not suppress an error just to make the interface appear successful.
- Make permission-sensitive actions consistent in the interface and native code. A hidden button alone is not an authorization check.
- Explain non-obvious decisions in comments. Remove abandoned code, debug output and temporary files.
- Review and understand everything you submit, including changes produced with development tools.

## Translations

Application strings live in [`src/i18n`](src/i18n/). Keep the `pt-BR`, `en` and
`es` dictionaries consistent. Preserve keys, interpolation variables, plural
forms and technical identifiers. Do not translate user-provided names, filenames,
URLs or brand names.

Keep a translation correction focused on the affected strings. For a new language,
discuss its integration first. Shared labels may be used by more than one app;
identify those in the PR rather than introducing a conflicting app-only copy.

## Verification

Choose checks that exercise the changed behavior. A meaningful bug regression
test should fail before the fix and pass afterward. Documentation-only edits do
not need a full native build: check links, examples, formatting and `git diff --check`.

For interface changes, attach before/after screenshots or a short recording and
check the affected input modes. Shared interaction changes need desktop, touch
and controller coverage. Test relevant empty, error, loading, read-only and
multi-selection cases, including focus restoration and scrolling when applicable.

Native changes need the actual installed app on the affected platform. A browser
preview does not validate native file pickers, permissions, media playback,
clipboard or gamepad input. Compilation for a platform is not a run on that platform.

In a configured workspace, the app's web build checks TypeScript and production
assets with `npm run build`; targeted Rust tests cover the affected native behavior.
Record the commands, results, platform and package you actually used. Explain any
remaining checks instead of marking them complete.

## Commits

Use atomic commits with English subjects in the existing format:

```text
<type>: <short description>
```

| Type | Use for |
| --- | --- |
| `feat` | New behavior. |
| `fix` | A bug fix. |
| `docs` | Documentation. |
| `refactor` | Restructuring without changing behavior. |
| `test` | Tests and test infrastructure. |
| `build` | Build tools and packaging. |
| `ci` | Continuous integration. |
| `chore` | Other repository maintenance. |

Write a concrete, imperative subject such as `fix: restore focus after closing a
dialog` or `docs: clarify Android installation`. Avoid subjects such as `updates`
or `fix stuff`. Each commit should be understandable and reviewable on its own.
Add a body when the reason or tradeoff is not clear from the diff.

Review the staged diff and commit only the intended files:

```sh
git diff --check
git add path/to/changed-file
git diff --cached
git commit -m "fix: restore focus after closing a dialog"
git push -u origin fix/restore-dialog-focus
```

Never commit Telegram sessions, API credentials, signing keys, pairing tokens,
account databases, personal media or build outputs. Use synthetic or explicitly
shareable files for screenshots and test fixtures. Keep third-party attribution
and license information with any new dependency or asset.

## Open a pull request

On GitHub, open a PR with **base** `TGCloudApps/tgphotos:main` and **head** set to
your fork's contribution branch. Use **Draft** while the work or validation is
incomplete. Use the same `<type>: <description>` format for the PR title.

Fill out the [PR template](.github/pull_request_template.md):

- **Problem:** the concrete trigger and why it matters; link an issue when one exists.
- **Change:** the resulting behavior and any important compatibility considerations.
- **Verification:** exact checks and results, tested platforms/input modes, and anything not run.
- **Visual evidence:** before/after images or a recording when the interface changes.

Use `Fixes #123` only when the PR fully resolves that issue. Use `Related to #123`
for partial work. Keep descriptions concise and update them if the scope changes.
Do not paste development chat transcripts or unrelated logs into the description.

Do not bump release versions, move tags or include release artifacts unless that
is the agreed purpose of the PR. Passing checks do not publish a release.

## During review

Respond to feedback in the same PR, explain a tradeoff when you disagree, and
push follow-up commits to its branch. Do not open a replacement PR for the same
change just to restart review. Maintainers may request a smaller scope, further
evidence or changes before merging.

Keep your branch compatible with current `main`. Resolve conflicts on your own
branch, review the resulting diff and rerun affected checks. Do not rewrite other
contributors' branches. Before requesting another review, summarize what changed
and which checks you repeated.

A PR is ready when its scope is clear, relevant checks pass, review requests are
addressed and the stated behavior is supported by evidence. Maintainers decide
whether to merge; opening a PR does not guarantee acceptance or a review deadline.

## Other ways to help

Confirm reproduction steps, test a proposed fix on your device, improve a guide,
or suggest clearer wording. Useful issue reports and accurate test results are
valuable contributions even without a code change.
