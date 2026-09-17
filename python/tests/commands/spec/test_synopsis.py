from mirage.commands.spec import SPECS
from mirage.commands.spec.help import render_help
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.types import CommandSpec, UsageStyle


def test_every_synopsis_names_a_builtin_and_starts_with_it():
    for name, line in SYNOPSES.items():
        assert name in SPECS
        assert line.split(" ", 1)[0] == name
        assert not line.startswith("Usage:")


def test_help_prints_the_synopsis_for_a_listed_command():
    assert "Usage: grep [OPTION]... PATTERNS [FILE]...\n" in render_help(
        "grep", SPECS["grep"])


def test_an_unlisted_command_keeps_the_synthesized_line():
    assert "Usage: nosuch\n" in render_help("nosuch", CommandSpec())


def test_a_listed_name_in_another_dialect_keeps_its_own_line():
    rendered = render_help("grep", CommandSpec(), style=UsageStyle.CLAP)
    assert "Usage: grep\n" in rendered
    assert "PATTERNS" not in rendered
