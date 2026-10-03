# vigil-copy-executor

Independent copy-trading executor component.

## Snapshot provenance

The root preserves the deployed build. local-worktree contains the executor source needed for a fresh build; run workspace commands from local-worktree.

Sanitized source snapshot prepared on 2026-10-03. Existing history is retained where available. Deployment endpoints, owned wallet addresses and credentials have been removed or replaced with non-operational placeholders. Compiled files are snapshots, not evidence that a fresh build has been validated.

## Configuration and safety

- Supply your own environment configuration, endpoints, public addresses and credentials locally. Never commit these values.
- This publication does not start a service, enable live trading, migrate funds or deploy contracts.
- Do not run transaction, approval, deployment, wallet recovery or funding commands against a funded account without a separate review.
- Databases, runtime state, personal operational notes and wallet key files are not part of this public repository.
- Runtime state is backed up separately in an encrypted private archive. Wallet secrets are excluded even from that archive.
