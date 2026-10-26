# YouTube Music fixtures — private

These are real Innertube responses recorded with `dev/capture.nyk` from the owner's signed-in profile
(`brand/` holds the same set captured as the `@janis.ishere` brand account). They contain **personal data**:
account names and handles, the library, liked songs, playlists and listening suggestions.

- Never commit them to a public repository. When this project becomes a git repo, ignore `tests/fixtures/ytm/`.
- `tests/test_pages.nyk` skips itself when they are absent; `tests/test_common.nyk` needs no fixtures.
- Re-record with `neyuki dev/capture.nyk "<search query>" [folder]` (read-only requests only).
