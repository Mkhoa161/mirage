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

from collections.abc import Mapping, Sequence

from mirage.commands.spec.constants import flag_kwarg_name
from mirage.commands.spec.types import CommandSpec, FlagValue
from mirage.types import PathSpec


class FlagView:
    """Typed read-only view over raw flag kwargs.

    Commands receive flags as an untyped mapping from the dispatcher; this
    view is the one sanctioned way to read them, replacing ad-hoc
    `flags.get(...) is True` and isinstance chains.

    Args:
        flags (Mapping[str, FlagValue] | None): raw flag kwargs.
        spec (CommandSpec | None): when given, reads of names the spec does
            not declare raise KeyError. A missing key is otherwise
            indistinguishable from "flag not passed", so a typo in the name
            would silently read as False/None.
        occurrences (Sequence[tuple[str, str]] | None): the parser's
            per-occurrence record of the scalar value flags the line
            carried (``CommandOpts.value_occurrences``), which is what
            ``value_occurrences`` answers from. None means no record was
            taken and the bag is read as the record.
    """

    def __init__(self,
                 flags: Mapping[str, FlagValue] | None,
                 spec: CommandSpec | None = None,
                 occurrences: Sequence[tuple[str, str]] | None = None) -> None:
        self._flags = flags if flags is not None else {}
        self._allowed = spec_flag_names(spec) if spec is not None else None
        self._occurrences = occurrences

    def _key(self, name: str) -> str:
        if self._allowed is not None and name not in self._allowed:
            raise KeyError(f"flag {name!r} is not declared by the command "
                           f"spec (known: {sorted(self._allowed)})")
        return name

    def typed_order(self, *names: str) -> list[str]:
        """The given flag names, ordered by their recorded occurrences.

        The parser fills the bag in scan order and every hop between
        (kwargs, dict copies) preserves insertion order, so a key's
        position is its last occurrence for a scalar, or its first for an
        accumulating option; a flag supplied
        by a default or the environment lands after every typed one.
        Names the line never carried are dropped. This is what an
        order-sensitive option family (grep's --include/--exclude,
        where the later kind overrides the earlier) reads, since the
        bag has no per-occurrence positions.

        Args:
            names (str): flag names to order.
        """
        wanted = {self._key(n) for n in names}
        return [k for k in self._flags if k in wanted]

    def value_occurrences(self, *names: str) -> list[tuple[str, str]]:
        """The named options' occurrences, in the order the line typed them.

        ``typed_order`` can only answer out of the bag, which keeps one
        value per scalar option -- the LAST occurrence of a repeated
        one. GNU validates each value the moment getopt hands it over,
        so a command that has to answer for the leftmost bad value
        (``nl -w abc -w 3`` refuses ``abc``) or refuse a repeat outright
        (``shuf -i 1-2 -i 3-4``) needs the occurrences the bag threw
        away. The parser records every scalar value-flag occurrence as
        it scans and the dispatcher hands that record over as
        ``CommandOpts.value_occurrences``, which is the ``occurrences``
        this view was built with. Without one (a view built straight
        from a bag, outside a dispatch) the bag is read as the record:
        that is exact for a line that typed each dest once, since its
        bag position is that one occurrence.

        Args:
            names (str): flag names to report the occurrences of.

        Returns:
            list[tuple[str, str]]: (name, raw value) pairs in scan
                order, for the named options the line carried. Values
                are raw argv text: a PATH-typed option's value is the
                word as typed, not the resolved path, and the bare
                boolean form of an optional-value flag carries no value
                and so does not appear.
        """
        wanted = {self._key(n) for n in names}
        if self._occurrences is not None:
            return [(dest, value) for dest, value in self._occurrences
                    if dest in wanted]
        recorded: list[tuple[str, str]] = []
        for dest in self.typed_order(*names):
            value = self._flags.get(dest)
            if isinstance(value, str):
                recorded.append((dest, value))
        return recorded

    def as_bool(self, name: str) -> bool:
        value = self._flags.get(self._key(name))
        if isinstance(value, bool):
            return value
        # A count flag holds an int; any occurrence reads as set.
        return isinstance(value, int) and value > 0

    def as_int(self, name: str) -> int | None:
        value = self._flags.get(self._key(name))
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if not isinstance(value, str):
            return None
        try:
            return int(value)
        except ValueError as exc:
            raise ValueError(f"flag '{name}' expects an integer, "
                             f"got '{value}'") from exc

    def as_float(self, name: str) -> float | None:
        value = self._flags.get(self._key(name))
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        if not isinstance(value, str):
            return None
        try:
            return float(value)
        except ValueError as exc:
            raise ValueError(f"flag '{name}' expects a number, "
                             f"got '{value}'") from exc

    def as_str(self, name: str) -> str | None:
        value = self._flags.get(self._key(name))
        return value if isinstance(value, str) else None

    def as_list(self, name: str) -> list[str]:
        value = self._flags.get(self._key(name))
        if isinstance(value, list):
            return [item for item in value if isinstance(item, str)]
        if isinstance(value, str):
            return [value]
        return []

    def as_paths(self, name: str) -> list[PathSpec]:
        # PATH-typed flag values arrive as PathSpec in the python
        # executor; the TypeScript flag bag carries their resolved
        # virtual-path strings, so its counterpart is asList.
        value = self._flags.get(self._key(name))
        if isinstance(value, list):
            return [item for item in value if isinstance(item, PathSpec)]
        if isinstance(value, PathSpec):
            return [value]
        return []

    def raw(self, name: str) -> FlagValue | None:
        return self._flags.get(self._key(name))


def spec_flag_names(spec: CommandSpec) -> frozenset[str]:
    """Collect the kwarg names a spec's options can produce.

    One name per option: the long spelling when an option declares
    both, matching the parser's canonical dest. Keeping the short
    spelling here too would let a stale ``fl.as_bool("a")`` stay legal
    and read False forever after dest unification; canonical-only
    turns that silent miss into a KeyError.

    Args:
        spec (CommandSpec): command spec whose options to enumerate.
    """
    names: set[str] = set()
    for option in spec.options:
        canonical = option.long if option.long is not None else option.short
        if canonical is not None:
            names.add(flag_kwarg_name(canonical))
    return frozenset(names)
