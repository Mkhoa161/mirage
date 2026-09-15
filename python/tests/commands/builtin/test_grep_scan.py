from functools import partial

import pytest

from mirage.commands.builtin.grep_pattern import compile_pattern
from mirage.commands.builtin.grep_scan import (grep_files_only, grep_lines,
                                               grep_recursive, grep_stream)
from mirage.commands.builtin.utils.wrap import (call_read_bytes, call_readdir,
                                                call_stat, to_pathspec)
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.read import read
from mirage.core.ram.readdir import readdir
from mirage.core.ram.stat import stat
from mirage.core.ram.write import write_bytes as _async_write_bytes
from mirage.io.types import IOResult
from mirage.types import ContentType, FileStat, FileType


@pytest.mark.asyncio
async def test_grep_files_only_recursive_scans_file_operands():
    # GNU: `grep -rl pat file` treats the operand as a file; only directory
    # operands are walked (search-narrowed candidates arrive as files).
    async def readdir_fn(path):
        raise FileNotFoundError(path)

    async def stat_fn(path):
        return FileStat(name=path,
                        type=FileType.FILE,
                        content=ContentType.TEXT)

    async def read_bytes_fn(path):
        return b"alpha beta\n"

    hits = await grep_files_only(
        readdir_fn,
        stat_fn,
        read_bytes_fn,
        "/data/notes.txt",
        "alpha",
        recursive=True,
        ignore_case=False,
        invert=False,
        line_numbers=False,
        count_only=False,
        fixed_string=False,
        only_matching=False,
        max_count=None,
        whole_word=False,
        basic=True,
        warnings=[],
    )
    assert hits == ["/data/notes.txt"]


async def _write(backend, path, content):
    accessor = backend.accessor
    await _async_write_bytes(accessor, to_pathspec(path), content.encode())


async def _mkdir(backend, path):
    accessor = backend.accessor
    await mkdir(accessor, to_pathspec(path), parents=True)


def _bind(backend):
    accessor = backend.accessor
    backend.index
    return (
        partial(call_readdir, partial(readdir, accessor)),
        partial(call_stat, partial(stat, accessor)),
        partial(call_read_bytes, partial(read, accessor)),
    )


async def grep(backend, path, pattern, **kwargs):
    rd, st, rb = _bind(backend)
    recursive = kwargs.pop("recursive", False)
    ignore_case = kwargs.pop("ignore_case", False)
    invert = kwargs.pop("invert", False)
    line_numbers = kwargs.pop("line_numbers", False)
    count_only = kwargs.pop("count_only", False)
    files_only = kwargs.pop("files_only", False)
    fixed_string = kwargs.pop("fixed_string", False)
    only_matching = kwargs.pop("only_matching", False)
    max_count = kwargs.pop("max_count", None)
    whole_word = kwargs.pop("whole_word", False)
    show_filename = kwargs.pop("show_filename", None)
    warnings = kwargs.pop("warnings", None)
    # These helpers predate the BRE default, so they keep the extended
    # dialect their patterns were written in.
    basic = kwargs.pop("basic", False)

    compiled = compile_pattern(pattern, ignore_case, fixed_string, whole_word,
                               basic)

    if recursive:
        results = await grep_recursive(
            rd,
            st,
            rb,
            path,
            compiled,
            invert,
            line_numbers,
            count_only,
            files_only,
            only_matching,
            max_count,
            warnings,
        )
        if show_filename is False and not count_only and not files_only:
            stripped = []
            for r in results:
                colon_idx = r.find(":")
                stripped.append(r[colon_idx + 1:] if colon_idx != -1 else r)
            return stripped
        return results

    return await grep_files_only(
        rd,
        st,
        rb,
        path,
        pattern,
        recursive=False,
        ignore_case=ignore_case,
        invert=invert,
        line_numbers=line_numbers,
        count_only=count_only,
        fixed_string=fixed_string,
        only_matching=only_matching,
        max_count=max_count,
        whole_word=whole_word,
        basic=basic,
        warnings=warnings,
    )


class TestGrepLines:

    def test_basic(self):
        compiled = compile_pattern("hello")
        result = grep_lines("/f.txt", ["hello world", "foo"], compiled, False,
                            False, False, False, False, None)
        assert result == ["hello world"]


class TestBasicMatching:

    @pytest.mark.anyio
    async def test_match_found(self, backend):
        await _write(backend, "/tmp/a.txt",
                     "hello world\nfoo bar\nhello again")
        result = await grep(backend, "/tmp/a.txt", "hello")
        assert result == ["/tmp/a.txt"]

    @pytest.mark.anyio
    async def test_no_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello world\nfoo bar")
        result = await grep(backend, "/tmp/a.txt", "xyz")
        assert result == []

    @pytest.mark.anyio
    async def test_empty_file(self, backend):
        await _write(backend, "/tmp/a.txt", "")
        result = await grep(backend, "/tmp/a.txt", "hello")
        assert result == []


class TestIgnoreCase:

    @pytest.mark.anyio
    async def test_ignore_case_matches(self, backend):
        await _write(backend, "/tmp/a.txt", "Hello World\nhello world\nHELLO")
        result = await grep(backend,
                            "/tmp/a.txt",
                            "hello",
                            ignore_case=True,
                            files_only=True)
        assert result == ["/tmp/a.txt"]


class TestInvert:

    @pytest.mark.anyio
    async def test_invert_match(self, backend):
        await _write(backend, "/tmp/a.txt", "hello\nworld\nhello again")
        result = await grep(backend,
                            "/tmp/a.txt",
                            "hello",
                            invert=True,
                            files_only=True)
        assert result == ["/tmp/a.txt"]


class TestCountOnly:

    @pytest.mark.anyio
    async def test_count_only(self, backend):
        await _write(backend, "/tmp/a.txt", "foo\nbar\nfoo baz")
        result = await grep(backend, "/tmp/a.txt", "foo", count_only=True)
        assert result == ["2"]


class TestRecursive:

    @pytest.mark.anyio
    async def test_recursive_basic(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "hello world")
        result = await grep(backend, "/tmp", "hello", recursive=True)
        assert "/tmp/a.txt:hello" in result
        assert "/tmp/sub/b.txt:hello world" in result

    @pytest.mark.anyio
    async def test_recursive_with_line_numbers(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/b.txt", "x\nhello\ny")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            line_numbers=True)
        assert "/tmp/sub/b.txt:2:hello" in result

    @pytest.mark.anyio
    async def test_recursive_with_files_only(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello")
        await _write(backend, "/tmp/sub/b.txt", "world")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            files_only=True)
        assert "/tmp/a.txt" in result
        assert "/tmp/sub/b.txt" not in result

    @pytest.mark.anyio
    async def test_recursive_with_count_only(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/a.txt", "hello\nhello")
        await _write(backend, "/tmp/sub/b.txt", "hello")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            count_only=True)
        assert len(result) > 0


class TestMixedFlags:

    @pytest.mark.anyio
    async def test_recursive_ignore_case_line_numbers(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/a.txt", "Hello\nworld")
        result = await grep(backend,
                            "/tmp",
                            "hello",
                            recursive=True,
                            ignore_case=True,
                            line_numbers=True)
        assert "/tmp/sub/a.txt:1:Hello" in result


class TestShowFilename:

    @pytest.mark.anyio
    async def test_grep_hide_filename_recursive(self, backend):
        await _mkdir(backend, "/tmp/sub")
        await _write(backend, "/tmp/sub/a.txt", "needle")
        result = await grep(backend,
                            "/tmp/sub/",
                            "needle",
                            recursive=True,
                            show_filename=False)
        assert result == ["needle"]


class TestWarnings:

    @pytest.mark.anyio
    async def test_warnings_on_missing_file(self, backend):
        warnings = []
        result = await grep(backend,
                            "/tmp/nonexistent.txt",
                            "foo",
                            warnings=warnings)
        assert result == []
        assert len(warnings) > 0
        assert "nonexistent" in warnings[0]

    @pytest.mark.anyio
    async def test_warnings_none_does_not_error(self, backend):
        result = await grep(backend,
                            "/tmp/nonexistent.txt",
                            "foo",
                            warnings=None)
        assert result == []

    @pytest.mark.anyio
    async def test_missing_file_warns_once_in_gnu_wording(self, backend):
        warnings = []
        result = await grep(backend,
                            "/tmp/nonexistent.txt",
                            "foo",
                            files_only=True,
                            warnings=warnings)
        assert result == []
        assert warnings == [
            "grep: /tmp/nonexistent.txt: No such file or directory"
        ]

    @pytest.mark.anyio
    async def test_files_only_names_a_directory_without_walking_it(
            self, backend):
        """GNU descends only under -r; -l alone reports the operand.

        The directory holds a match, so a walk would put a filename on stdout.
        """
        await _mkdir(backend, "/tmp/walk")
        await _write(backend, "/tmp/walk/a.txt", "needle")
        warnings = []
        result = await grep(backend,
                            "/tmp/walk",
                            "needle",
                            files_only=True,
                            warnings=warnings)
        assert result == []
        assert warnings == ["grep: /tmp/walk: Is a directory"]

    @pytest.mark.anyio
    async def test_recursive_still_walks_a_directory(self, backend):
        """-r keeps the walk the no-flag case gives up.

        Calls grep_files_only itself rather than the shared harness, which
        routes recursive runs straight to grep_recursive and so would not
        reach the branch under test.
        """
        await _mkdir(backend, "/tmp/rwalk")
        await _write(backend, "/tmp/rwalk/a.txt", "needle")
        rd, st, rb = _bind(backend)
        warnings = []
        result = await grep_files_only(
            rd,
            st,
            rb,
            "/tmp/rwalk",
            "needle",
            recursive=True,
            ignore_case=False,
            invert=False,
            line_numbers=False,
            count_only=False,
            fixed_string=False,
            only_matching=False,
            max_count=None,
            whole_word=False,
            basic=False,
            warnings=warnings,
        )
        assert result == ["/tmp/rwalk/a.txt"]
        assert warnings == []


async def _byte_source(data):
    yield data


async def _run_stream(data, pattern, **kwargs):
    io = IOResult(exit_code=1)
    chunks = []
    async for chunk in grep_stream(_byte_source(data),
                                   compile_pattern(pattern),
                                   io=io,
                                   **kwargs):
        chunks.append(chunk)
    return b"".join(chunks), io


def _only(lines, pattern, **kwargs):
    return grep_lines("/f.txt", lines, compile_pattern(pattern),
                      kwargs.get("invert", False),
                      kwargs.get("line_numbers", False),
                      kwargs.get("count_only", False),
                      kwargs.get("files_only", False), True,
                      kwargs.get("max_count"), kwargs.get("io"))


class TestGrepLinesReportsSelection:
    """`grep_lines` answers selection on an IOResult, as `grep_stream` does.

    The returned list cannot stand in for it: under -o an empty match
    prints nothing and still selects the line, so a caller deriving the
    status from an empty list answers 1 where GNU answers 0. `rg`'s
    multi-operand and -H branches read it off this channel.
    """

    def test_empty_match_selects_the_line_although_nothing_prints(self):
        io = IOResult(exit_code=1)
        assert _only(["ab"], "[0-9]*", io=io) == []
        assert io.exit_code == 0

    def test_no_match_at_all_leaves_the_seeded_status(self):
        io = IOResult(exit_code=1)
        assert _only(["ab"], "[0-9]", io=io) == []
        assert io.exit_code == 1

    def test_a_printed_match_also_selects(self):
        io = IOResult(exit_code=1)
        assert _only(["a1b"], "[0-9]", io=io) == ["1"]
        assert io.exit_code == 0

    def test_selection_is_reported_under_count_only(self):
        io = IOResult(exit_code=1)
        assert _only(["ab"], "[0-9]*", count_only=True, io=io) == ["1"]
        assert io.exit_code == 0

    def test_omitting_the_channel_is_still_supported(self):
        assert _only(["a1b"], "[0-9]") == ["1"]


class TestOnlyMatchingEmptyMatches:
    """GNU's two-part -o rule, which is easy to half-implement.

    An empty match prints nothing, but the line is still selected: `-c`
    counts it, the exit status is 0, and grep's binary-file notice still
    fires. And every non-empty match on the line prints, one per line,
    not just the first.
    """

    def test_lines_path_drops_the_empty_match(self):
        assert _only(["ab"], "[0-9]*") == []

    def test_lines_path_still_selects_the_line_for_count(self):
        assert _only(["ab"], "[0-9]*", count_only=True) == ["1"]

    def test_lines_path_still_selects_the_line_for_files_only(self):
        assert _only(["ab"], "[0-9]*", files_only=True) == ["/f.txt"]

    def test_lines_path_keeps_only_the_real_match(self):
        assert _only(["a1b"], "[0-9]*") == ["1"]

    def test_lines_path_prints_every_match_on_the_line(self):
        assert _only(["a1b2c"], "[0-9]") == ["1", "2"]

    def test_lines_path_keeps_nonempty_runs_in_order(self):
        assert _only(["1a22b"], "[0-9]*") == ["1", "22"]

    def test_lines_path_numbers_every_printed_match(self):
        assert _only(["a1b2c"], "[0-9]", line_numbers=True) == ["1:1", "1:2"]

    @pytest.mark.anyio
    async def test_stream_path_drops_the_empty_match(self):
        out, io = await _run_stream(b"ab\n", "[0-9]*", only_matching=True)
        assert out == b""
        assert io.exit_code == 0

    @pytest.mark.anyio
    async def test_stream_path_drops_an_empty_pattern(self):
        out, io = await _run_stream(b"ab\n", "", only_matching=True)
        assert out == b""
        assert io.exit_code == 0

    @pytest.mark.anyio
    async def test_stream_path_drops_a_start_anchor(self):
        out, io = await _run_stream(b"ab\n", "^", only_matching=True)
        assert out == b""
        assert io.exit_code == 0

    @pytest.mark.anyio
    async def test_stream_path_selects_every_line_with_no_output(self):
        out, io = await _run_stream(b"a\nb\n", "[0-9]*", only_matching=True)
        assert out == b""
        assert io.exit_code == 0

    @pytest.mark.anyio
    async def test_stream_path_counts_the_selected_line_not_the_matches(self):
        # `grep -oc '[0-9]*'` on `ab` is 1, not 0 and not ripgrep's 3.
        out, io = await _run_stream(b"ab\n",
                                    "[0-9]*",
                                    only_matching=True,
                                    count_only=True)
        assert out == b"1\n"
        assert io.exit_code == 0

    @pytest.mark.anyio
    async def test_stream_path_keeps_only_the_real_match(self):
        out, _ = await _run_stream(b"a1b\n", "[0-9]*", only_matching=True)
        assert out == b"1\n"

    @pytest.mark.anyio
    async def test_stream_path_prints_every_match_on_the_line(self):
        out, _ = await _run_stream(b"a1b2c\n", "[0-9]", only_matching=True)
        assert out == b"1\n2\n"

    @pytest.mark.anyio
    async def test_stream_path_keeps_nonempty_runs_in_order(self):
        out, _ = await _run_stream(b"1a22b\n", "[0-9]*", only_matching=True)
        assert out == b"1\n22\n"

    @pytest.mark.anyio
    async def test_stream_path_keeps_the_one_nonempty_star_match(self):
        out, _ = await _run_stream(b"abc\n", "b*", only_matching=True)
        assert out == b"b\n"

    @pytest.mark.anyio
    async def test_stream_path_numbers_every_printed_match(self):
        out, _ = await _run_stream(b"a1b\n",
                                   "[0-9]*",
                                   only_matching=True,
                                   line_numbers=True)
        assert out == b"1:1\n"

    @pytest.mark.anyio
    async def test_stream_path_reports_no_selection_when_nothing_matches(self):
        out, io = await _run_stream(b"ab\n", "[0-9]", only_matching=True)
        assert out == b""
        assert io.exit_code == 1
