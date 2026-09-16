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

import dataclasses
import json
import re
import shlex
import sys
from pathlib import Path
from typing import Any

import yaml

REPO = Path(__file__).resolve().parent.parent
WORKFLOW = REPO / ".github/workflows/test_typescript.yml"
TS_ROOT = REPO / "typescript"
ROOT_MANIFEST = TS_ROOT / "package.json"
PACKAGES = TS_ROOT / "packages"
LEG_PREFIX = "test:leg:"
FILTER = re.compile(r"--filter(?:=|\s+)(\S+)")
MATRIX_REF = re.compile(r"matrix\.([A-Za-z_][A-Za-z0-9_-]*)")

NO_MATRIX = ("{file}: no jobs.test.strategy.matrix (stopped at {key!r}); the "
             "job or its matrix was renamed, and this gate cannot see the leg "
             "table any more")
NO_LEG_DIM = ("{file}: jobs.test.strategy.matrix has no `leg` dimension; this "
              "gate cannot see the leg table any more")
NO_TEST_SCRIPT = ("{name} declares no `test` script; the root `test` script "
                  "selects ./packages/* and pnpm.requiredScripts lists "
                  "`test`, so this breaks `pnpm test` for everyone as well as "
                  "going unclaimed by any leg")
JOB_MAY_FAIL = ("the `test` job is `continue-on-error: true`, so every leg "
                "reports success whatever its tests do and "
                "test-typescript-gate goes green over a red run")
NO_LIVE_STEP = ("no step runs `{wanted}` on a live line that can fail the "
                "job; a step that is absent, `if: false`, "
                "`continue-on-error: true` or only mentions it in a comment "
                "all leave the legs selected by the matrix and then never "
                "invoked")
STRAY_INCLUDE = ("include row for leg {leg!r} matches no declared leg "
                 "({legs}); GitHub cannot merge it into a combination, so it "
                 "becomes a spurious extra job and the leg it was meant for "
                 "loses {lost}")
FALSY_GATE = ("include sets `{key}: {value!r}` on {where}; a falsy value "
              "gates nothing, so every step behind `if: matrix.{key}` is "
              "skipped on every leg and the run still reports green")
UNSET_GATE = ("step(s) {steps} run only `if: matrix.{key}`, which no include "
              "row sets, so they are skipped on every leg and the run still "
              "reports green")
NO_LEG_SCRIPT = ("matrix leg {leg!r} has no {prefix}{leg} script in "
                 "typescript/package.json; the job would fail on the runner "
                 "with pnpm's \"Missing script\"")
WRONG_VERB = ("{prefix}{leg} runs {ran!r}, not `test`; it would select the "
              "right packages and run the wrong script, and pnpm's "
              "requiredScripts only guards the `test` verb it never reaches")
SCRIPT_UNUSED = ("script {prefix}{leg} is never run: {leg!r} is absent from "
                 "the matrix leg list, so every package it claims is tested "
                 "by nobody")
CLOSURE_FILTER = ("leg {leg!r} filters {token!r}: a `...` selector pulls the "
                  "dependency closure back into the leg and re-serialises "
                  "what the split exists to remove")
DOUBLE_FILTER = "leg {leg!r} filters {name!r} more than once"
BAD_PACKAGE = "leg(s) {legs} filter {name!r}, which {why}"
NO_TEST_WHY = "exists but declares no `test` script"
UNKNOWN_WHY = "is not a workspace package"
DOUBLE_CLAIM = ("{name} is claimed by more than one leg ({legs}), so its "
                "tests run twice")
UNCLAIMED = "{name} is claimed by no leg, so CI never runs its tests"


def package_of(token: str) -> str:
    """Reduce a `--filter` token to the package name it selects.

    `strip` is the wrong tool for pnpm's `...pkg` closure syntax: it would
    eat the leading dot of a path selector like `./packages/core`.

    Args:
        token (str): one whitespace-delimited word following `--filter`.

    Returns:
        The package name, without quoting or closure syntax.
    """
    name = token.strip("\"'")
    return name.removeprefix("...").removesuffix("...")


def invoked_script(body: str) -> str | None:
    """Name the npm script a leg body actually runs.

    Tokenised rather than pattern-matched: `-` and `:` are regex word
    boundaries, so a pattern loose enough to accept the repo's own
    `pnpm ... test` spelling also accepts `run test:unit`. A chained body
    returns None rather than being segmented, since the point is to name
    one script.

    Args:
        body (str): the script body from typescript/package.json.

    Returns:
        The script name, or None when the body chains or invokes nothing.
    """
    if any(sep in body for sep in ("&&", ";", "|")):
        return None
    words = shlex.split(body)
    if "run" in words:
        rest = words[words.index("run") + 1:]
        return rest[0] if rest else None
    return words[-1] if words else None


def leg_scripts(manifest: dict[str, Any]) -> dict[str, str]:
    """Read the `test:leg:<name>` scripts out of the root manifest.

    Args:
        manifest (dict[str, Any]): the parsed typescript/package.json.

    Returns:
        A mapping of leg name to the script body that runs it.
    """
    scripts = manifest.get("scripts", {})
    return {
        name[len(LEG_PREFIX):]: body
        for name, body in scripts.items() if name.startswith(LEG_PREFIX)
    }


def test_matrix(workflow: dict[str, Any]) -> dict[str, Any]:
    """Reach the `test` job's matrix, naming the miss if the shape moved.

    Args:
        workflow (dict[str, Any]): the parsed test_typescript.yml.

    Returns:
        The matrix mapping.
    """
    where = str(WORKFLOW.relative_to(REPO))
    node: Any = workflow
    for key in ("jobs", "test", "strategy", "matrix"):
        if not isinstance(node, dict) or key not in node:
            raise SystemExit(NO_MATRIX.format(file=where, key=key))
        node = node[key]
    if "leg" not in node:
        raise SystemExit(NO_LEG_DIM.format(file=where))
    return node


def gated_steps(workflow: dict[str, Any]) -> dict[str, list[str]]:
    """Map each `matrix.<key>` a step's `if:` reads to the steps reading it.

    Args:
        workflow (dict[str, Any]): the parsed test_typescript.yml.

    Returns:
        A mapping of matrix key to the names of the steps gated on it.
    """
    gated: dict[str, list[str]] = {}
    for step in workflow["jobs"]["test"].get("steps", []):
        for key in MATRIX_REF.findall(str(step.get("if", ""))):
            gated.setdefault(key, []).append(step.get("name", "<unnamed>"))
    return gated


def package_members() -> dict[str, bool]:
    """Map each `typescript/packages/*` member to whether it has a test.

    Returns:
        Package name to whether its manifest declares a `test` script.
    """
    members: dict[str, bool] = {}
    for manifest in sorted(PACKAGES.glob("*/package.json")):
        data = json.loads(manifest.read_text())
        members[data["name"]] = "test" in data.get("scripts", {})
    return members


def audit_packages(members: dict[str, bool]) -> list[str]:
    """Refuse a `packages/*` member that declares no `test` script.

    Such a member is not merely unclaimed by a leg: `pnpm.requiredScripts`
    makes `pnpm test` fail outright for every developer.

    Args:
        members (dict[str, bool]): package name to whether it has a test.

    Returns:
        One line per member missing a test script.
    """
    return [
        NO_TEST_SCRIPT.format(name=name)
        for name, has_test in sorted(members.items()) if not has_test
    ]


def runs_command(step: dict[str, Any], command: str) -> bool:
    """Whether a step actually executes `command`.

    Mentioning it is not running it: a shell comment, an `echo` quoting it,
    a step turned off with `if: false` or one allowed to fail all leave the
    text in place while nothing runs. Same shape as `check_skip_hooks.py`.

    Args:
        step (dict[str, Any]): one parsed workflow step.
        command (str): the command text the step must invoke.

    Returns:
        True when a live line of the step's `run:` invokes it.
    """
    if step.get("continue-on-error") is True:
        return False
    if str(step.get("if", "")).strip().strip("${} ").lower() == "false":
        return False
    script = step.get("run")
    if not isinstance(script, str):
        return False
    for line in script.split("\n"):
        text = line.lstrip()
        if not text.startswith("#") and text.startswith("pnpm"):
            if command in text:
                return True
    return False


def audit_invocation(job: dict[str, Any]) -> list[str]:
    """Check that the job really runs the leg script the matrix selects.

    Everything else here assumes the workflow invokes the selected leg and
    lets it fail the run. Deleting the step, hardcoding one leg, disabling
    it or marking it allowed-to-fail each leave a green gate over a job
    that tested nothing.

    Args:
        job (dict[str, Any]): the parsed `test` job.

    Returns:
        One line per way the invocation is absent or defanged.
    """
    wanted = LEG_PREFIX + "${{ matrix.leg }}"
    problems: list[str] = []
    if job.get("continue-on-error") is True:
        problems.append(JOB_MAY_FAIL)
    if not any(runs_command(step, wanted) for step in job.get("steps", [])):
        problems.append(NO_LIVE_STEP.format(wanted=wanted))
    return problems


def audit_gates(matrix: dict[str, Any], gated: dict[str,
                                                    list[str]]) -> list[str]:
    """Check every `if: matrix.<key>` step against the include rows.

    Bare truthiness on an absent key is false everywhere, so mistyping
    `examples:` as `example:` deletes a whole battery and leaves the run
    green.

    Args:
        matrix (dict[str, Any]): the `test` job's matrix.
        gated (dict[str, list[str]]): matrix key to the steps gated on it.

    Returns:
        One line per key that is read but never set, or set but never read.
    """
    dims = {key for key in matrix if key != "include"}
    declared = set(matrix["leg"])
    provided: dict[str, list[str]] = {}
    problems: list[str] = []
    for row in matrix.get("include", []):
        leg = row.get("leg")
        if leg is not None and leg not in declared:
            problems.append(
                STRAY_INCLUDE.format(leg=leg,
                                     legs=", ".join(matrix["leg"]),
                                     lost=", ".join(sorted(set(row) - {"leg"}))
                                     or "nothing"))
        for key, value in row.items():
            if key in dims:
                continue
            if not value:
                problems.append(
                    FALSY_GATE.format(key=key,
                                      value=value,
                                      where=f"leg {leg}"
                                      if leg is not None else "every leg"))
            provided.setdefault(
                key, []).append(str(leg) if leg is not None else "all")

    for key, steps in sorted(gated.items()):
        if key in dims or key in provided:
            continue
        problems.append(UNSET_GATE.format(steps=", ".join(steps), key=key))
    return problems


def audit(scripts: dict[str, str], declared: list[str], packages: set[str],
          known: set[str]) -> list[str]:
    """Compare the two halves of the leg table against the workspace.

    Args:
        scripts (dict[str, str]): leg name to `test:leg:*` script body.
        declared (list[str]): the leg names the workflow matrix runs.
        packages (set[str]): workspace members that declare a test script.
        known (set[str]): every workspace member, testable or not.

    Returns:
        One human-readable line per disagreement, empty when they agree.
    """
    problems: list[str] = []
    for leg in declared:
        if leg not in scripts:
            problems.append(NO_LEG_SCRIPT.format(leg=leg, prefix=LEG_PREFIX))
    for leg in declared:
        body = scripts.get(leg)
        if body is None:
            continue
        ran = invoked_script(body)
        if ran != "test":
            problems.append(
                WRONG_VERB.format(
                    prefix=LEG_PREFIX,
                    leg=leg,
                    ran=ran or "no single script (the body chains commands)"))
    for leg in scripts:
        if leg not in declared:
            problems.append(SCRIPT_UNUSED.format(prefix=LEG_PREFIX, leg=leg))

    claims: dict[str, list[str]] = {}
    for leg in declared:
        seen: set[str] = set()
        for token in FILTER.findall(scripts.get(leg, "")):
            if "..." in token:
                problems.append(CLOSURE_FILTER.format(leg=leg, token=token))
            name = package_of(token)
            if name in seen:
                problems.append(DOUBLE_FILTER.format(leg=leg, name=name))
                continue
            seen.add(name)
            claims.setdefault(name, []).append(leg)

    for name, legs in sorted(claims.items()):
        if name not in packages:
            problems.append(
                BAD_PACKAGE.format(
                    legs=", ".join(sorted(legs)),
                    name=name,
                    why=NO_TEST_WHY if name in known else UNKNOWN_WHY))
        elif len(legs) > 1:
            problems.append(
                DOUBLE_CLAIM.format(name=name, legs=", ".join(sorted(legs))))
    for name in sorted(packages - set(claims)):
        problems.append(UNCLAIMED.format(name=name))
    return problems


CORE = "@struktoai/mirage-core"
NODE = "@struktoai/mirage-node"
DSH = "@struktoai/mirage-dsh"
BOTH = {CORE, NODE}
AB = ["a", "b"]
MATRIX = {"node-version": ["24"], "leg": ["core", "cli"]}
LIVE = "pnpm run test:leg:${{ matrix.leg }}"


@dataclasses.dataclass(frozen=True, kw_only=True)
class Fixture:
    """A made-up repo and the refusal it has to produce.

    `expect` is the answer key: a substring the refusal must contain, or
    empty for a fixture the gate has to pass in silence.
    """

    name: str
    expect: str = ""

    def problems(self) -> list[str]:
        """Run the audit this fixture exercises.

        Returns:
            Every refusal the audit produced for this fixture.
        """
        raise NotImplementedError


@dataclasses.dataclass(frozen=True, kw_only=True)
class LegCase(Fixture):
    """A leg table, against the workspace it claims to cover.

    The defaults are the healthy two-leg repo, so a fixture spells out
    only what it breaks. `tested` is the packages that have a `test`
    script and `known` is every package that exists: a name in neither is
    a typo, one in `known` alone is a package that lost its script.
    """

    scripts: dict[str, str]
    declared: list[str] = dataclasses.field(default_factory=AB.copy)
    tested: set[str] = dataclasses.field(default_factory=BOTH.copy)
    known: set[str] = dataclasses.field(default_factory=BOTH.copy)

    def problems(self) -> list[str]:
        """Audit the leg table.

        Returns:
            Every refusal `audit` produced for this fixture.
        """
        return audit(self.scripts, self.declared, self.tested, self.known)


@dataclasses.dataclass(frozen=True, kw_only=True)
class GateCase(Fixture):
    """Matrix include rows, against the steps whose `if:` reads them."""

    include: list[dict[str, Any]]
    gated: dict[str, list[str]]

    def problems(self) -> list[str]:
        """Audit the include rows against the gated steps.

        Returns:
            Every refusal `audit_gates` produced for this fixture.
        """
        return audit_gates({**MATRIX, "include": self.include}, self.gated)


@dataclasses.dataclass(frozen=True, kw_only=True)
class InvocationCase(Fixture):
    """A `test` job, against the leg script it is supposed to run."""

    job: dict[str, Any]

    def problems(self) -> list[str]:
        """Audit the job's invocation of the selected leg.

        Returns:
            Every refusal `audit_invocation` produced for this fixture.
        """
        return audit_invocation(self.job)


@dataclasses.dataclass(frozen=True, kw_only=True)
class PackageCase(Fixture):
    """Workspace members, against whether each declares a `test` script."""

    members: dict[str, bool]

    def problems(self) -> list[str]:
        """Audit the members for a missing `test` script.

        Returns:
            Every refusal `audit_packages` produced for this fixture.
        """
        return audit_packages(self.members)


CLEAN = {"a": f"--filter {CORE} run test", "b": f"--filter {NODE} run test"}
LEG_CASES = (
    LegCase(name="clean table", scripts=CLEAN),
    LegCase(name="package claimed by no leg",
            scripts={"a": CLEAN["a"]},
            declared=["a"],
            expect="claimed by no leg"),
    LegCase(name="package claimed twice",
            scripts={
                **CLEAN, "b": f"--filter {CORE} --filter {NODE} run test"
            },
            expect="more than one leg"),
    LegCase(name="filter names a package that does not exist",
            scripts={
                **CLEAN, "a": f"{CLEAN['a']} --filter @struktoai/ghost"
            },
            expect="is not a workspace package"),
    LegCase(name="filter names a package that lost its test script",
            scripts={
                **CLEAN, "a": f"--filter {CORE} --filter {DSH} run test"
            },
            known=BOTH | {DSH},
            expect="declares no `test` script"),
    LegCase(name="script the matrix never runs",
            scripts=CLEAN,
            declared=["a"],
            expect="is never run"),
    LegCase(name="matrix leg with no script",
            scripts={"a": f"--filter {CORE} --filter {NODE} run test"},
            expect="has no test:leg:b"),
    LegCase(name="leg script runs the wrong verb",
            scripts={
                **CLEAN, "a": f"--filter {CORE} run build"
            },
            expect="not `test`"),
    LegCase(name="ellipsis selector",
            scripts={
                **CLEAN, "a": f"--filter {CORE}... run test"
            },
            expect="dependency closure"),
    LegCase(name="same package filtered twice in one leg",
            scripts={
                **CLEAN, "a": f"--filter {CORE} --filter {CORE} run test"
            },
            expect="more than once"),
    LegCase(name="--filter=name is read, not missed",
            scripts={
                **CLEAN, "a": f"--filter={CORE} run test"
            }),
    LegCase(name="a quoted name is read, not reported stale",
            scripts={
                "a": f"--filter '{CORE}' run test",
                "b": f'--filter "{NODE}" run test'
            }),
)

TYPECHECK = {"typecheck": ["Typecheck"]}
EXAMPLES = {"examples": ["Examples"]}
GATE_CASES = (
    GateCase(name="every gated key is set",
             include=[{
                 "leg": "cli",
                 "typecheck": True
             }],
             gated=TYPECHECK),
    GateCase(name="a gated key no include row sets",
             include=[],
             gated=EXAMPLES,
             expect="skipped on every leg"),
    GateCase(name="a gated key set to false",
             include=[{
                 "leg": "cli",
                 "typecheck": False
             }],
             gated=TYPECHECK,
             expect="falsy value"),
    GateCase(name="a gated key set to an empty string",
             include=[{
                 "leg": "cli",
                 "examples": ""
             }],
             gated=EXAMPLES,
             expect="falsy value"),
    GateCase(name="an include row for an undeclared leg",
             include=[{
                 "leg": "ghost",
                 "examples": True
             }],
             gated=EXAMPLES,
             expect="matches no declared leg"),
)

DEAD = "no step runs"
INVOCATION_CASES = (
    InvocationCase(name="a step runs the selected leg",
                   job={"steps": [{
                       "run": LIVE
                   }]}),
    InvocationCase(name="no step runs any leg",
                   job={"steps": [{
                       "run": "pnpm -r build"
                   }]},
                   expect=DEAD),
    InvocationCase(name="a step hardcodes one leg",
                   job={"steps": [{
                       "run": "pnpm run test:leg:core"
                   }]},
                   expect=DEAD),
    InvocationCase(name="the step is allowed to fail",
                   job={"steps": [{
                       "run": LIVE,
                       "continue-on-error": True
                   }]},
                   expect=DEAD),
    InvocationCase(name="the step is turned off with if: false",
                   job={"steps": [{
                       "run": LIVE,
                       "if": False
                   }]},
                   expect=DEAD),
    InvocationCase(name="the step is turned off with ${{ false }}",
                   job={"steps": [{
                       "run": LIVE,
                       "if": "${{ false }}"
                   }]},
                   expect=DEAD),
    InvocationCase(name="the leg is only named in a comment",
                   job={"steps": [{
                       "run": f"# {LIVE}\necho skipped"
                   }]},
                   expect=DEAD),
    InvocationCase(name="the leg is only echoed, not run",
                   job={"steps": [{
                       "run": f'echo "{LIVE}"'
                   }]},
                   expect=DEAD),
    InvocationCase(name="the whole job is allowed to fail",
                   job={
                       "continue-on-error": True,
                       "steps": [{
                           "run": LIVE
                       }]
                   },
                   expect="continue-on-error: true"),
)

PACKAGE_CASES = (
    PackageCase(name="every package has a test",
                members={
                    "a": True,
                    "b": True
                }),
    PackageCase(name="a package with no test script",
                members={
                    "a": True,
                    "b": False
                },
                expect="declares no `test` script"),
)

GROUPS: tuple[tuple[str, tuple[Fixture, ...]], ...] = (
    ("leg table", LEG_CASES),
    ("matrix gates", GATE_CASES),
    ("invocation", INVOCATION_CASES),
    ("packages", PACKAGE_CASES),
)


def run_cases(label: str, cases: tuple[Fixture, ...]) -> int:
    """Run one group of selftest fixtures.

    Args:
        label (str): the group name, printed as a heading.
        cases (tuple[Fixture, ...]): the fixtures in that group.

    Returns:
        The number of fixtures that did not behave as expected.
    """
    failures = 0
    print(f"  {label}")
    for case in cases:
        problems = case.problems()
        hit = any(case.expect in problem for problem in problems)
        if (hit and case.expect) or (not problems and not case.expect):
            print(f"    ok   {case.name}")
            continue
        failures += 1
        want = (f"a problem containing {case.expect!r}"
                if case.expect else "none")
        print(f"    FAIL {case.name}: expected {want}, got {problems}")
    return failures


def selftest() -> int:
    """Prove each refusal fires before trusting the gate to be silent.

    Returns:
        0 when every fixture is classified as expected.
    """
    failures = sum(run_cases(label, cases) for label, cases in GROUPS)
    if failures:
        print(f"\n{failures} selftest case(s) failed; the gate cannot see a "
              f"drift it claims to cover.")
        return 1
    total = sum(len(cases) for _, cases in GROUPS)
    print(f"\nselftest OK: {total} drift shapes covered")
    return 0


def main() -> int:
    """Fail when the CI leg table and the workspace have drifted apart.

    The table lives in two files -- the `test:leg:*` scripts in
    typescript/package.json carry the package selections, and the workflow
    matrix decides which of them ever run -- so a check that read only one
    would pass while a whole leg's packages went untested.

    Returns:
        0 when every package is claimed by exactly one running leg, else 1.
    """
    if "--selftest" in sys.argv[1:]:
        return selftest()

    workflow = yaml.safe_load(WORKFLOW.read_text())
    matrix = test_matrix(workflow)
    scripts = leg_scripts(json.loads(ROOT_MANIFEST.read_text()))
    declared = list(matrix["leg"])
    members = package_members()
    packages = {name for name, has in members.items() if has}
    problems = audit(scripts, declared, packages, set(members))
    problems += audit_gates(matrix, gated_steps(workflow))
    problems += audit_invocation(workflow["jobs"]["test"])
    problems += audit_packages(members)
    if problems:
        print(f"{WORKFLOW.relative_to(REPO)} and "
              f"{ROOT_MANIFEST.relative_to(REPO)} disagree:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"ok: every workspace package with a test script "
          f"({len(packages)}) is claimed by exactly one of "
          f"{len(declared)} legs ({', '.join(declared)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
