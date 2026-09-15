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

import posixpath

from mirage.commands.builtin.constants import BINARY_EXTENSIONS
from mirage.commands.builtin.grep_context import grep_context_lines
from mirage.commands.builtin.grep_pattern import compile_pattern
from mirage.commands.builtin.utils.types import (AsyncReadBytes, AsyncReaddir,
                                                 AsyncStat)
from mirage.commands.resolve import get_extension
from mirage.types import FileType
from mirage.utils.errors import WALK_ERRORS, fs_strerror
from mirage.utils.fnmatch import fnmatch

_TYPE_EXTENSIONS: dict[str, list[str]] = {
    "py": [".py"],
    "js": [".js", ".jsx"],
    "ts": [".ts", ".tsx"],
    "java": [".java"],
    "go": [".go"],
    "rs": [".rs"],
    "rb": [".rb"],
    "c": [".c", ".h"],
    "cpp": [".cpp", ".hpp", ".cc", ".cxx"],
    "css": [".css"],
    "html": [".html", ".htm"],
    "json": [".json"],
    "yaml": [".yaml", ".yml"],
    "toml": [".toml"],
    "md": [".md"],
    "txt": [".txt"],
    "xml": [".xml"],
    "sql": [".sql"],
    "sh": [".sh", ".bash"],
    "csv": [".csv"],
}


def _rg_matches_filter(
    entry: str,
    file_type: str | None,
    glob_pattern: str | None,
    hidden: bool,
) -> bool:
    basename = posixpath.basename(entry)
    if not hidden and basename.startswith("."):
        return False
    if file_type is not None:
        exts = _TYPE_EXTENSIONS.get(file_type, [f".{file_type}"])
        if not any(entry.endswith(ext) for ext in exts):
            return False
    if glob_pattern is not None and not fnmatch(basename, glob_pattern):
        return False
    return True


async def rg_full(
    readdir_fn: AsyncReaddir,
    stat_fn: AsyncStat,
    read_bytes_fn: AsyncReadBytes,
    path: str,
    pattern: str,
    ignore_case: bool,
    invert: bool,
    line_numbers: bool,
    count_only: bool,
    files_only: bool,
    fixed_string: bool,
    only_matching: bool,
    max_count: int | None,
    whole_word: bool,
    context_before: int,
    context_after: int,
    file_type: str | None,
    glob_pattern: str | None,
    hidden: bool,
    warnings: list[str] | None,
    file_prefix: str | None = None,
    no_filename: bool = False,
) -> list[str]:
    compiled = compile_pattern(pattern, ignore_case, fixed_string, whole_word)

    is_dir = False
    try:
        s = await stat_fn(path)
        is_dir = s.type == FileType.DIRECTORY
    except WALK_ERRORS:
        try:
            await readdir_fn(path)
            is_dir = True
        except WALK_ERRORS:
            # not a directory (or vanished): treat the operand as a file
            pass

    if not is_dir:
        if not _rg_matches_filter(path, file_type, glob_pattern, hidden):
            return []
        try:
            data = (await
                    read_bytes_fn(path)).decode(errors="replace").splitlines()
        except WALK_ERRORS as exc:
            if warnings is not None:
                warnings.append(f"rg: {path}: {fs_strerror(exc) or exc}")
            return []
        if ((context_before or context_after) and not files_only
                and not count_only and not only_matching
                and file_prefix is None):
            # Single-file context rides the shared grep renderer (match
            # lines `N:`, context lines `N-`, `--` between groups).
            # Directory search and filename-prefixed fanout skip context,
            # mirroring grep's -H divergence.
            rendered = grep_context_lines(data, compiled, invert, line_numbers,
                                          max_count, context_after,
                                          context_before)
            return [b.decode().rstrip("\n") for b in rendered]
        results: list[str] = []
        count = 0
        for i_ln, line in enumerate(data, 1):
            m = compiled.search(line)
            matched = bool(m) != invert
            if not matched:
                continue
            count += 1
            if files_only:
                return [path]
            if only_matching and m and not invert:
                # GNU -o prints every match on the line, one per line,
                # and prints nothing at all for an empty match -- but
                # the line is still selected, so `count` is already
                # incremented above and -c, -l and the exit status see
                # it. Mirrors `searchFile` in rg_scan.ts and
                # `grep_lines` in grep_scan.py; a bare `search` here
                # printed only the first match, and printed a prefix
                # with no match after it for an empty one.
                for found in compiled.finditer(line):
                    text = found.group(0)
                    if not text:
                        continue
                    one = f"{i_ln}:{text}" if line_numbers else text
                    results.append(f"{file_prefix}:{one}"
                                   if file_prefix is not None else one)
            else:
                one = f"{i_ln}:{line}" if line_numbers else line
                results.append(
                    f"{file_prefix}:{one}" if file_prefix is not None else one)
            if max_count is not None and count >= max_count:
                break
        if count_only:
            if count == 0:
                return []
            return [f"{file_prefix}:{count}"
                    ] if file_prefix is not None else [str(count)]
        return results

    results = []
    try:
        entries = await readdir_fn(path)
    except WALK_ERRORS as exc:
        if warnings is not None:
            warnings.append(f"rg: {path}: {fs_strerror(exc) or exc}")
        return results

    for entry in entries:
        try:
            s = await stat_fn(entry)
        except WALK_ERRORS as exc:
            if warnings is not None:
                warnings.append(f"rg: {entry}: {fs_strerror(exc) or exc}")
            continue

        if s.type == FileType.DIRECTORY:
            basename = posixpath.basename(entry)
            if not hidden and basename.startswith("."):
                continue
            results.extend(await rg_full(
                readdir_fn,
                stat_fn,
                read_bytes_fn,
                entry,
                pattern,
                ignore_case,
                invert,
                line_numbers,
                count_only,
                files_only,
                fixed_string,
                only_matching,
                max_count,
                whole_word,
                context_before,
                context_after,
                file_type,
                glob_pattern,
                hidden,
                warnings,
                no_filename=no_filename,
            ))
        elif s.type is FileType.FILE:
            if get_extension(entry) in BINARY_EXTENSIONS:
                continue
            if not _rg_matches_filter(entry, file_type, glob_pattern, hidden):
                continue
            try:
                data = (await read_bytes_fn(entry)).decode(
                    errors="replace").splitlines()
                file_count = 0
                for i_ln, line in enumerate(data, 1):
                    m = compiled.search(line)
                    matched = bool(m) != invert
                    if not matched:
                        continue
                    file_count += 1
                    if files_only:
                        results.append(entry)
                        break
                    if count_only:
                        if max_count is not None and file_count >= max_count:
                            break
                        continue
                    # ripgrep -I drops per-file labels in directory
                    # walks, which is the only thing this branch words
                    # differently from the single-file one above; -o
                    # itself reads the same, one printed line per
                    # non-empty match and nothing at all for an empty
                    # one.
                    if only_matching and m and not invert:
                        for found in compiled.finditer(line):
                            text = found.group(0)
                            if not text:
                                continue
                            one = (f"{i_ln}:{text}" if line_numbers else text)
                            results.append(
                                one if no_filename else f"{entry}:{one}")
                    else:
                        one = f"{i_ln}:{line}" if line_numbers else line
                        results.append(
                            one if no_filename else f"{entry}:{one}")
                if count_only and file_count > 0:
                    results.append(
                        str(file_count
                            ) if no_filename else f"{entry}:{file_count}")
            except WALK_ERRORS as exc:
                if warnings is not None:
                    warnings.append(f"rg: {entry}: {fs_strerror(exc) or exc}")
                continue

    return results
