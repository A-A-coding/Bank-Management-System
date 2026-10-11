# Contributing

## Backlog

- Epics, stories, story points and sprints are defined in [`.github/backlog/backlog.yml`](.github/backlog/backlog.yml).
- The **Backlog Sync** workflow turns that file into GitHub issues, milestones and Project fields. To change the backlog, edit the file in a PR; don't edit generated issues by hand (ticking checkboxes is fine).
- Task-set owners are set in [`.github/backlog/assignees.yml`](.github/backlog/assignees.yml).

## Working on a story

1. Pick an issue assigned to you in the current sprint and move it to *In Progress* on the board.
2. Create a branch from `main`: `feat/S-07-login`, `fix/S-18-daily-limit`, `docs/S-34-srs-use-case`.
3. Commit in small steps. Commit messages use `type(scope): summary`, e.g. `feat(auth): verify password hash`.
4. Open a PR into `main`:
   - Title: `type(scope): summary` (checked by the **PR Automation** workflow).
   - Description: `Closes #<issue number>` (also checked).
5. CI builds and tests on Linux and Windows. Fix any failures.
6. The repo owner reviews and merges (squash merge). The linked issue closes automatically.

## Definition of done

- Acceptance criteria in the issue are met and ticked.
- Unit tests added and passing in CI.
- Reviewed and merged by the repo owner.
- Any deviation from the SRS, SADS or Test Plan is recorded in `docs/DEVIATIONS.md`.
