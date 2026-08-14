# Contributing to Hippo Core

Thank you for helping build trustworthy shared memory for AI agents.

## Development

Requirements: Node.js 22 or newer, npm, and Git.

```bash
npm ci
npm test
npm run benchmark
npm run pack:check
```

Create a focused branch, add tests for behavior changes, and open a pull request. CI must pass on Windows, macOS, and Linux. Do not commit API keys, user configuration, memory databases, test secrets, or generated package archives.

## Design principles

- Keep memory local and user-owned by default.
- Preserve existing agent configuration and create backups before managed edits.
- Reject secrets before persistence.
- Prefer safe, reversible lifecycle operations.
- Label token savings as context estimates, not provider billing.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not the public issue tracker.
