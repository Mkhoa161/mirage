import pytest

from mirage.commands.builtin.generic.sort import parse_flags, sort
from mirage.commands.errors import UsageError
from mirage.io.types import materialize
from mirage.types import PathSpec


async def _unused_read_bytes(_path: PathSpec) -> bytes:
    raise AssertionError("read_bytes should not be called")


@pytest.mark.asyncio
async def test_no_operand_uses_empty_standard_input():
    stdout, io = await sort([], read_bytes=_unused_read_bytes)

    assert await materialize(stdout) == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_zero_field_keydef_exits_two():
    stdout, io = await sort([],
                            read_bytes=_unused_read_bytes,
                            stdin=b"a\nb\n",
                            key_defs=["0"])

    assert await materialize(stdout) == b""
    assert io.exit_code == 2
    assert b"field number is zero" in await materialize(io.stderr)


# GNU's ARGMATCH refusal names the refused word through gnulib's quote(),
# so a byte outside 0x20-0x7e comes back escaped. Rows measured against
# GNU coreutils 9.4 under `LC_ALL=C` with a raw `bytes` argv
# (`sort --check=<w>`). Mirrored in sort.test.ts.
@pytest.mark.parametrize("value,escaped", [
    ("xé", r"x\303\251"),
    ("x\r", r"x\r"),
    ("x\x01", r"x\001"),
    ("x\x7f", r"x\177"),
    ("x'", r"x\'"),
    ("x\\", r"x\\"),
])
def test_check_refusal_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_flags({"check": value})
    assert str(exc.value).startswith(
        f"sort: invalid argument '{escaped}' for '--check'\n")


def test_check_refusal_carries_gnus_candidate_block_and_exit_1():
    """Measured, coreutils 9.4: `sort --check=x f` is SIX lines, exit 1.

    `quiet` and `silent` are aliases of one value, so gnulib's
    `argmatch_valid` puts them on one `  - ` row. The exit is 1, not
    sort's usual usage code of 2, because `argmatch_die` always calls
    `usage (EXIT_FAILURE)`.
    """
    with pytest.raises(UsageError) as exc:
        parse_flags({"check": "x"})
    assert str(exc.value) == ("sort: invalid argument 'x' for '--check'\n"
                              "Valid arguments are:\n"
                              "  - 'quiet', 'silent'\n"
                              "  - 'diagnose-first'\n"
                              "Try 'sort --help' for more information.")
    assert exc.value.exit_code == 1


def test_an_empty_check_is_ambiguous():
    """`sort --check=` is `ambiguous argument ''`, exit 1 (measured)."""
    with pytest.raises(UsageError) as exc:
        parse_flags({"check": ""})
    assert str(
        exc.value).startswith("sort: ambiguous argument '' for '--check'\n")
    assert exc.value.exit_code == 1


# gnulib's argmatch resolves an unambiguous prefix of one candidate, so
# `sort --check=q`, `=s` and `=d` all exit 0 (measured, coreutils 9.4).
# `quiet` and `silent` are one value, so its canonical word decides
# whether the check is quiet.
def test_check_accepts_an_unambiguous_prefix():
    assert parse_flags({"check": "q"}).check_quiet
    assert parse_flags({"check": "s"}).check_quiet
    assert parse_flags({"check": "silent"}).check_quiet
    assert parse_flags({"check": "quiet"}).check_quiet
    assert not parse_flags({"check": "d"}).check_quiet
    assert not parse_flags({"check": "diagnose"}).check_quiet
    assert parse_flags({"check": "d"}).check


def test_check_still_refuses_a_word_no_candidate_starts_with():
    with pytest.raises(UsageError) as exc:
        parse_flags({"check": "qu1et"})
    assert str(
        exc.value).startswith("sort: invalid argument 'qu1et' for '--check'\n")
