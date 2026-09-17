# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import functools
from collections.abc import Awaitable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Protocol, cast

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.constants import ROOT_CWD
from mirage.commands.spec import SPECS, CommandSpec
from mirage.commands.spec.builtin_specs import (VERSION_OPTION,
                                                is_builtin_grammar,
                                                registered_spec)
from mirage.commands.spec.compile import compile_spec, expand_long
from mirage.commands.spec.constants import (SOLE_ARGUMENT_LONG_OPTIONS,
                                            VERSION_AFTER_SCAN,
                                            VERSION_BEFORE_SCAN)
from mirage.commands.spec.help import render_help
from mirage.commands.spec.parser import parse_command
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import NamespaceView, ReaddirPath, SessionView, StatPath
from mirage.runtime.base import Runtime
from mirage.runtime.types import DispatchFn, ExecPathFn
from mirage.types import Limit, PathSpec
from mirage.version import __version__


@dataclass(frozen=True, slots=True)
class ExecContext:
    """The execution context ``Mount.execute_cmd`` takes: everything
    the workspace supplies for one invocation beyond the parsed line.

    The one bag a dispatcher call site builds (mirrors the options
    object TypeScript's ``Mount.executeCmd`` has always taken as its
    fifth argument, named ``ExecContext`` there too). ``execute_cmd``
    re-boxes these onto ``CommandOpts`` beside the facts only the mount
    can supply (mount_prefix, index, filetype_fns), so every field here
    is spelled exactly as ``CommandOpts`` spells it — one fact has one
    name on both sides of the seam, pinned by
    ``tests/commands/test_exec_context_parity.py``. ``session_view``
    stays although no ``opts`` reader wants it today, because
    ``CLIDoors.session_view`` has production readers and the doors
    record is pinned to be a subset of ``CommandOpts``.

    Args:
        stdin (ByteSource | None): Piped standard input, if any.
        cwd (str): The session's working directory, as a virtual path;
            ``execute_cmd`` promotes it to the PathSpec handlers read.
        dispatch (DispatchFn | None): The workspace op dispatch.
        session_id (str | None): The calling session.
        env (dict[str, str] | None): The session environment snapshot.
        exec_allowed (bool): Whether the policy layer permits spawning
            an interpreter.
        exec_path_allowed (ExecPathFn | None): Whether code may be
            loaded from one path.
        runtime (Runtime | None): The resolved runtime for interpreter
            commands.
        runtime_unavailable (str | None): Why the requested runtime is
            unavailable (python-only; the TS table refuses at
            resolution time).
        ns (NamespaceView | None): The name plane's facts.
        stat_path (StatPath | None): Dispatcher-backed stat of one path.
        readdir_path (ReaddirPath | None): Dispatcher-backed readdir of
            one path.
        session_view (SessionView | None): The session plane's live,
            gated handle.
    """

    stdin: ByteSource | None = None
    cwd: str = "/"
    dispatch: DispatchFn | None = None
    session_id: str | None = None
    env: dict[str, str] | None = None
    exec_allowed: bool = True
    exec_path_allowed: ExecPathFn | None = None
    runtime: Runtime | None = None
    runtime_unavailable: str | None = None
    ns: NamespaceView | None = None
    stat_path: StatPath | None = None
    readdir_path: ReaddirPath | None = None
    session_view: SessionView | None = None


@dataclass(frozen=True, slots=True)
class CommandOpts:
    """The dispatcher context of one command invocation, as one value.

    Mirrors the TypeScript ``CommandOpts`` (commands/config.ts): the
    dispatcher (``Mount.execute_cmd``) constructs it once and hands it
    to every handler as the fourth argument, so builders and bespoke
    backend wrappers are wiring that passes it through. The generic owns
    everything inside it (flag parsing via a spec-bound FlagView, the
    stdin fallback); the wiring owns everything outside it (glob
    resolution, op binding, push-downs). A handler reads the fields it
    wants and ignores the rest, so there is no opt-in registry anywhere.

    Args:
        stdin (ByteSource | None): Piped standard input, if any.
        flags (Mapping[str, FlagValue]): The parsed command-line flag
            bag — only real flags, no injected context.
        cwd (PathSpec): The session's working directory, promoted by the
            dispatcher — the mount-relative key rides ``resource_path``
            for operand defaulting. Always a PathSpec (the TS twin keeps
            a string and threads ``mount_prefix`` instead).
        mount_prefix (str): The owning mount's prefix, for commands that
            render mount-relative names.
        filetype_fns (Mapping[str, CommandFn] | None): Extension-specific
            handlers of the same command, for a generic that delegates
            per operand; None when the handler itself is one of them.
        command (str | None): The full command string, set on the
            provision path only.
        spec (CommandSpec | None): The invoked command's spec, set on the
            provision path: a provision function is shared across
            commands, so it needs the spec to resolve a flag spelling.
        index (IndexCacheStore): The mount's index cache store.
        dispatch (DispatchFn | None): The workspace op dispatch, for
            interpreter commands whose sandboxed I/O rides it.
        session_id (str | None): The calling session, for commands that
            record per-session state.
        env (dict[str, str] | None): The session environment.
        exec_allowed (bool): Whether the policy layer permits spawning
            an interpreter.
        exec_path_allowed (ExecPathFn | None): Whether code may be
            loaded from one path, for an interpreter's file operand;
            None outside a workspace, where ``exec_allowed`` answers
            for files too.
        runtime (Runtime | None): The resolved runtime for interpreter
            commands.
        runtime_unavailable (str | None): The hint naming why the
            requested runtime is unavailable. Python-only: the TS
            runtime table refuses at resolution time instead.
        ns (NamespaceView | None): The name plane's facts (symlinks,
            mount boundaries, attr overlay, child names the namespace
            owes a directory), which no backend can see.
        stat_path (StatPath | None): Dispatcher-backed stat of one path,
            for a traversal command's start point.
        readdir_path (ReaddirPath | None): Dispatcher-backed readdir of
            one path, for a walker that reads past a mount boundary.
        session_view (SessionView | None): The session plane's live,
            gated handle (reads and gate-cleared writes); ``env`` above
            stays the frozen process-view snapshot.
    """

    stdin: ByteSource | None = None
    flags: Mapping[str, FlagValue] = field(default_factory=dict)
    cwd: PathSpec = ROOT_CWD
    mount_prefix: str = ""
    filetype_fns: Mapping[str, "CommandFn"] | None = None
    command: str | None = None
    spec: CommandSpec | None = None
    index: IndexCacheStore = NULL_INDEX
    dispatch: DispatchFn | None = None
    session_id: str | None = None
    env: dict[str, str] | None = None
    exec_allowed: bool = True
    exec_path_allowed: ExecPathFn | None = None
    runtime: Runtime | None = None
    runtime_unavailable: str | None = None
    ns: NamespaceView | None = None
    stat_path: StatPath | None = None
    readdir_path: ReaddirPath | None = None
    session_view: SessionView | None = None


CommandFnResult = tuple[ByteSource | None, IOResult] | None


class CommandFn(Protocol):
    """Command handler signature, mirroring the TS ``CommandFn``.

    Four positional parameters — accessor, paths, texts, opts — on both
    sides. Handlers that narrow the accessor to their backend's type are
    cast at registration (``command``), exactly like the TS
    ``options.fn as CommandFn``, so the dispatcher call site stays
    typed.
    """

    def __call__(self, accessor: Accessor, paths: list[PathSpec],
                 texts: list[str],
                 opts: CommandOpts) -> Awaitable[CommandFnResult]:
        ...


class ProvisionFn(Protocol):
    """Provision estimator signature, mirroring the TS ``ProvisionFn``.

    Same four positional parameters as ``CommandFn``; the provision-only
    context (``command``, ``spec``) rides in ``opts``.
    """

    def __call__(self, accessor: Accessor, paths: list[PathSpec],
                 texts: list[str], opts: CommandOpts) -> Awaitable[Any]:
        ...


def version_line(name: str) -> bytes:
    """Render the GNU-style version line for a command.

    Args:
        name (str): command name as invoked.
    """
    return f"{name} (Mirage) {__version__}\n".encode()


def has_injected_version(spec: CommandSpec | None) -> bool:
    """Whether the wrapper supplies this spec's version response.

    Args:
        spec (CommandSpec | None): the registered command spec.
    """
    return spec is not None and any(o is VERSION_OPTION for o in spec.options)


def _is_injected_version(spec: CommandSpec, arg: str) -> bool:
    """Whether one raw word names the injected --version.

    getopt_long's rule, so an unambiguous abbreviation counts and an
    ambiguous one does not. A word carrying a value is declined: GNU
    answers `--version=x` with `option '--version' doesn't allow an
    argument`, which is the parser's to say, not this function's.

    Args:
        spec (CommandSpec): the registered spec, --version already
            injected.
        arg (str): one word of argv, as typed.
    """
    if not arg.startswith("--") or "=" in arg:
        return False
    return expand_long(compile_spec(spec), arg) == ("--version", )


def _version_index(spec: CommandSpec, argv: list[str]) -> int | None:
    """Where the scan would read the injected --version, if anywhere.

    None when no word names it, or when the first one sits after the
    `--` end-of-options marker, which ends the scan.

    Args:
        spec (CommandSpec): the registered spec, --version already
            injected.
        argv (list[str]): the words after the command name.
    """
    for index, arg in enumerate(argv):
        if arg == "--":
            return None
        if _is_injected_version(spec, arg):
            return index
    return None


def _scan_refuses(name: str, spec: CommandSpec, words: list[str]) -> bool:
    """Whether the parser refuses an option in these words.

    The same parse the line gets downstream, so the two agree by
    construction rather than by a second reading of the grammar; only
    the option reports are read, which is why a cwd the caller does not
    have is not one it needs (nothing here consumes a resolved path).
    ``missing_required_options`` is deliberately not read: these words
    are a PREFIX of the line for every command but the two that defer,
    so an option declared later has not been reached yet.

    Args:
        name (str): command name as invoked, for the per-program rules
            the grammar cannot state.
        spec (CommandSpec): the registered spec.
        words (list[str]): the words the scan has read.
    """
    parsed = parse_command(spec, words, ROOT_CWD.virtual, name)
    return bool(parsed.option_error_kinds
                or parsed.old_option_needs_value is not None)


def version_request(name: str, spec: CommandSpec | None,
                    argv: list[str]) -> bytes | None:
    """Version output when argv asks a command for the injected --version.

    None when the command declares its own --version, when the flag is
    absent, when it sits after the `--` end-of-options marker, or when
    an option the scan reads first is one the parser refuses.

    This runs on raw argv, ahead of the parser, so it has to honor the
    two rules the parser states about a long option's POSITION.

    The first is which words the scan has read when it answers, because
    `--version` is an option like any other and an option error the
    scan meets first is what GNU reports: measured on coreutils 9.7 and
    grep 3.11, `cat --bogus --vers` is `unrecognized option '--bogus'`
    (exit 1) and `grep --bogus --vers` is grep's own (exit 2), where
    `cat --version --bogus` prints the version and exits 0 because
    coreutils answers INSIDE the scan loop. So the words ahead of the
    option are re-read through the parser, and a refusal among them
    declines the answer and leaves the ordinary path to word it. Two
    families answer elsewhere and carry their own tables:
    VERSION_AFTER_SCAN finishes the whole line first, VERSION_BEFORE_SCAN
    answers ahead of every option. Both are gated on the spec being the
    builtin's own grammar, since a mount may register a command under
    one of those names.

    The second is gnulib's ``parse_long_options``, which reads argv[1]
    only when it is the whole line (``argc == 2``), so for a
    SOLE_ARGUMENT_LONG_OPTIONS command `--version` is an ordinary
    operand as soon as another word joins it. Measured on coreutils
    9.7: `expr --version` is the version and `expr --version x` is
    `expr: syntax error: unexpected argument 'x'`. Inside that window
    the parser's own prefix expansion still answers (`expr --versio`),
    which is why this only has to decline rather than re-match.

    A word is the injected option when it resolves to it the way
    getopt_long would, not only when it is spelled out in full, because
    the parser downstream expands an abbreviation and the two have to
    agree: a line that spans mounts is parsed against the SHARED spec,
    which carries no injected --version, so `cat --vers /ram/a /disk/b`
    refused the prefix while `cat --vers /ram/a` expanded it and exited
    0. Resolution is against the registered spec, the one the parser
    would use, so an abbreviation that is ambiguous there (or carries a
    value) is declined here and refused downstream in getopt_long's own
    words rather than answered.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec | None): the command's registered spec.
        argv (list[str]): the words after the command name.
    """
    if spec is None or not has_injected_version(spec):
        return None
    builtin = is_builtin_grammar(name, spec)
    if builtin and name in SOLE_ARGUMENT_LONG_OPTIONS:
        return (version_line(name) if len(argv) == 1
                and _is_injected_version(spec, argv[0]) else None)
    index = _version_index(spec, argv)
    if index is None:
        return None
    if builtin and name in VERSION_BEFORE_SCAN:
        return version_line(name)
    # Everything ahead of the option has to scan cleanly, which is both
    # halves of "the scan reaches this word as an option": a refusal
    # among those words is what GNU reports instead, and a value-taking
    # option that swallowed this one (`grep -e --version`) leaves its
    # own refusal there, so declining hands the word back to the
    # ordinary path to read as that option's value, as GNU does.
    if _scan_refuses(name, spec, argv[:index]):
        return None
    # A program that answers only after the whole scan needs the rest of
    # the line to be clean too.
    if (builtin and name in VERSION_AFTER_SCAN
            and _scan_refuses(name, spec, argv)):
        return None
    return version_line(name)


def help_page(name: str, spec: CommandSpec) -> bytes:
    """One command's ``--help`` page.

    The page is rendered from ``help_spec``, not from the declared spec,
    so it documents the two options every command answers rather than
    only the ones its author wrote down. Only the builtin itself gets
    GNU's own synopsis line: a registered command that borrowed the name
    keeps the line its own spec synthesizes, which is why this asks for
    the spec OBJECT rather than trusting the name.

    Args:
        name (str): command name as invoked.
        spec (CommandSpec): the command's declared grammar, before the
            two standard options are injected.
    """
    synopsis = SYNOPSES.get(name) if SPECS.get(name) is spec else None
    return render_help(name, registered_spec(name, spec),
                       synopsis=synopsis).encode()


def _with_help_support(
        name: str, spec: CommandSpec,
        fn: Callable[..., Any]) -> tuple[CommandSpec, CommandFn]:
    """Inject --help / --version and short-circuit them before the handler.

    Mirrors GNU coreutils: every registered command accepts both flags,
    prints to stdout, and exits 0 without running the command body.
    A command declaring its own --version handles that flag itself.
    """
    has_version = any(o.long == "--version" for o in spec.options)
    new_spec = registered_spec(name, spec)
    help_text = help_page(name, spec)
    version_text = version_line(name)

    @functools.wraps(fn)
    async def wrapper(accessor: Accessor, paths: list[PathSpec],
                      texts: list[str], opts: CommandOpts) -> CommandFnResult:
        if opts.flags.get("help") is True:
            return yield_bytes(help_text), IOResult()
        if not has_version and opts.flags.get("version") is True:
            return yield_bytes(version_text), IOResult()
        return await fn(accessor, paths, texts, opts)

    return new_spec, wrapper


class _Unset:
    __slots__ = ()


_UNSET = _Unset()


@dataclass(frozen=True, slots=True)
class RegisteredCommand:
    name: str
    spec: CommandSpec
    resource: str | None
    filetype: str | None
    fn: CommandFn
    provision_fn: ProvisionFn | None = None
    aggregate: Callable[..., Any] | None = None
    src: str | None = None
    dst: str | None = None
    write: bool = False
    limit: Limit | None = None

    def with_overrides(
        self,
        *,
        fn: CommandFn | _Unset = _UNSET,
        provision: ProvisionFn | None | _Unset = _UNSET,
    ) -> "RegisteredCommand":
        """Return an independent command definition with selected changes."""
        return replace(
            self,
            fn=(self.fn if fn is _UNSET else cast(CommandFn, fn)),
            provision_fn=(self.provision_fn if provision is _UNSET else cast(
                ProvisionFn | None, provision)),
        )


def command(
    name: str,
    *,
    resource: str | list[str] | None,
    spec: CommandSpec,
    filetype: str | None = None,
    provision: Callable[..., Any] | None = None,
    dry_run: Callable[..., Any] | None = None,
    aggregate: Callable[..., Any] | None = None,
    write: bool = False,
    limit: Limit | None = None,
) -> Callable[..., Any]:

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        resources = (resource if isinstance(resource, list) else [resource])
        new_spec, wrapped_fn = _with_help_support(name, spec, fn)
        provision_fn = cast(ProvisionFn | None, provision or dry_run)
        # functools.wraps copies function attributes by reference. Copy the
        # registration list before extending it so wrapping a builtin cannot
        # add registrations to the shared backend command.
        cmds = list(getattr(wrapped_fn, "_registered_commands", []))
        for p in resources:
            rc = RegisteredCommand(
                name=name,
                spec=new_spec,
                resource=p,
                filetype=filetype,
                fn=wrapped_fn,
                provision_fn=provision_fn,
                aggregate=aggregate,
                write=write,
                limit=limit,
            )
            cmds.append(rc)
        setattr(wrapped_fn, "_registered_commands", cmds)
        return wrapped_fn

    return decorator


def cross_command(
    name: str,
    *,
    src: str,
    dst: str,
    spec: CommandSpec,
) -> Callable[..., Any]:

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        rc = RegisteredCommand(
            name=name,
            spec=spec,
            resource=f"{src}->{dst}",
            filetype=None,
            fn=cast(CommandFn, fn),
            src=src,
            dst=dst,
        )
        cmds = getattr(fn, "_registered_commands", [])
        cmds.append(rc)
        setattr(fn, "_registered_commands", cmds)
        return fn

    return decorator
