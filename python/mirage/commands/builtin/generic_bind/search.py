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

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping

from mirage.commands.builtin.generic.grep import grep as generic_grep
from mirage.commands.builtin.generic.rg import rg as generic_rg
from mirage.commands.builtin.generic_bind.adapter import CommandIO, bound_op
from mirage.commands.builtin.grep_pattern import pattern_arg
from mirage.commands.builtin.grep_pushdown import text_search_results
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.context import hidden_paths_intersect, path_rules_active
from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.scope import ROOT, DetectFn
from mirage.core.hierarchy.search import Searcher, SearchQuery
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

QualifyFn = Callable[
    [list[PathSpec], Mapping[str, FlagValue] | None, str | None],
    PathSpec | None]

SearchCommand = Callable[[A, list[PathSpec], list[str], CommandOpts],
                         Awaitable[tuple[ByteSource | None, IOResult]]]

_GENERICS = {"grep": generic_grep, "rg": generic_rg}


def native_or_bytes(
    read_stream: Callable[[PathSpec], AsyncIterator[bytes]],
    read_bytes: Callable[[PathSpec], Awaitable[bytes]],
) -> Callable[[PathSpec], AsyncIterator[bytes]]:
    """A stream that falls back to the whole read on a first-pull failure.

    A native stream may serve only some kinds (mongodb streams
    documents.jsonl and refuses schema.json before yielding anything), so
    a failure before any data has flowed falls back to ``read_bytes``; an
    error after data has flowed is real and propagates. Mirrors the TS
    ``nativeOrBytes`` in ``generic_bind/search.ts``.

    Args:
        read_stream (Callable[[PathSpec], AsyncIterator[bytes]]): the
            bound native stream op.
        read_bytes (Callable[[PathSpec], Awaitable[bytes]]): the bound
            whole-read op the first pull falls back to.
    """

    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        it = read_stream(path).__aiter__()
        try:
            first = await it.__anext__()
        except StopAsyncIteration:
            return
        except OSError:
            yield await read_bytes(path)
            return
        yield first
        async for chunk in it:
            yield chunk

    return stream


def make_search(
    name: str,
    detect: DetectFn,
    searchers: Mapping[str, Searcher[A]],
    io: CommandIO,
    *,
    qualify: QualifyFn,
    guard: bool = False,
    stream: bool = False,
) -> SearchCommand[A]:
    """Build a grep/rg handler: push a qualified search down, scan the rest.

    The handler is the shared shape every hierarchy backend's search
    wrapper had by hand: qualify the line, classify the operand, hand a
    matched kind to its searcher, and print the lines it answers (an
    empty answer is grep's exit 1). Anything the push-down cannot answer,
    an unqualified line, an unmatched kind, or a missing pattern, takes
    the generic scan wired from the same ``io`` the backend's other
    commands use.

    Args:
        name (str): ``grep`` or ``rg``; picks the spec and the generic.
        detect (DetectFn): the backend's scope classifier.
        searchers (Mapping[str, Searcher]): one searcher per scope kind
            the backend can answer natively.
        io (CommandIO): the backend's command I/O, for the generic scan.
        qualify (QualifyFn): which lines may push down
            (``literal_pushdown_operand`` for a substring backend,
            ``pushdown_operand`` for a regex one).
        guard (bool): stat the operand (existence check) before a
            non-root search runs.
        stream (bool): wire the backend's native read_stream into the
            generic scan; False keeps the whole-read path.
    """
    spec = SPECS[name]

    async def search_cmd(
            accessor: A, paths: list[PathSpec], texts: list[str],
            opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
        generic = _GENERICS[name]
        fl = FlagView(opts.flags, spec=spec)
        pattern = pattern_arg(texts, fl)
        operand = qualify(paths, opts.flags, pattern)
        # A native search answers from the raw backend, so it would
        # print lines out of files the session cannot see, or ones a
        # path rule refuses; the generic scan classifies through the
        # guarded readdir/stat instead. Per operand, like find's fork.
        pushdown_open = (operand is None
                         or (not hidden_paths_intersect(operand.virtual)
                             and not path_rules_active()))
        if pattern is not None and operand is not None and pushdown_open:
            match = detect(operand)
            searcher = searchers.get(match.kind)
            if searcher is not None:
                if guard and match.kind != ROOT:
                    await io.stat(accessor, operand, index=opts.index)
                query = SearchQuery(pattern=pattern,
                                    ignore_case=fl.as_bool("i"),
                                    fixed_string=fl.as_bool("F"),
                                    whole_word=fl.as_bool("w"))
                lines = await searcher(accessor, match, query)
                if not lines:
                    return b"", IOResult(exit_code=1)
                if name != "grep" or text_search_results(lines):
                    return format_records(lines), IOResult()

        resolved = await io.resolve_glob(accessor, paths,
                                         index=opts.index) if paths else []
        return await generic(
            resolved,
            texts,
            opts,
            readdir=bound_op(io.readdir, accessor, opts.index),
            stat=bound_op(io.stat, accessor, opts.index),
            read_bytes=bound_op(io.read_bytes, accessor, opts.index),
            read_stream=native_or_bytes(
                bound_op(io.read_stream, accessor, opts.index),
                bound_op(io.read_bytes, accessor, opts.index))
            if stream else None,
            stdin=opts.stdin,
        )

    return search_cmd
