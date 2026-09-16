---
'@struktoai/mirage-server': minor
'@struktoai/mirage-cli': patch
---

Cut the `mirage` CLI's cold start from ~0.82s to ~0.05s per invocation. `@struktoai/mirage-server` now publishes `paths`, `env`, `daemon_config`, `host_validation_constants`, `workspace_config`, `auth/config` and `auth/storage` as subpath exports, so a consumer that needs one constant no longer loads the barrel — which re-exports Fastify, jose, isomorphic-git and the whole `@struktoai/mirage-node` graph. The CLI imports through those subpaths and defers `@struktoai/mirage-agents/mcp`, `@struktoai/mirage-node/config` and `yaml` to the handlers that use them. The barrel keeps every export it had.
