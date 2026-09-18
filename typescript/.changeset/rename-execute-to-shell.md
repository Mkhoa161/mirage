---
'@struktoai/mirage-core': minor
'@struktoai/mirage-node': minor
'@struktoai/mirage-browser': minor
'@struktoai/mirage-cli': minor
'@struktoai/mirage-server': minor
'@struktoai/mirage-agents': minor
'@struktoai/mirage-dsh': minor
---

Rename `Workspace.execute` and `SessionHandle.execute` to `shell`.

`shell` names the one door that parses a bash line, so it no longer collides with `Runtime.execute`, `Mount.executeCmd` and `Workspace.executePythonRepl`. The signature is unchanged. Adapter surfaces fixed by a third-party protocol (`LangchainWorkspace.execute`, `MirageToolOperations.execute`) keep their names.

Every `Ops` method takes a trailing `sessionId`, the way `Workspace.shell` takes one: `ws.fs.readFile(path, {}, 'agent_a')` reads as that session when no shell line is running, and the running line's session wins when one is. `Ops.forSession` is no longer part of the supported surface; bind with `await ws.session(id)` (creates or adopts) or `new SessionHandle(ws, id)` (adopts only). `SessionHandle.shell` gained the third overload `Workspace.shell` already had, so both accept an options object whose `provision` is not statically known.

`Workspace.ops` is now `Workspace.opsRegistry`. It returns the `OpsRegistry`, not the `Ops` facade, and sat one letter away from `fs`; the new spelling says which of the two it is.
