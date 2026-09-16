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


def package_of(token: str) -> str:
    """Reduce a `--filter` token to the package name it selects.

    pnpm accepts the name quoted, and `...pkg` / `pkg...` to pull in the
    dependency closure. Only the bare name is comparable against the
    workspace, and `strip` is the wrong tool for the closure syntax: it
    would eat the leading dot of a path selector like `./packages/core`.

    Args:
        token (str): one whitespace-delimited word following `--filter`.

    Returns:
        The package name, without quoting or closure syntax.
    """
    name = token.strip("\"'")
    return name.removeprefix("...").removesuffix("...")


def invoked_script(body: str) -> str | None:
    """Name the npm script a leg body actually runs.

    Tokenised rather than pattern-matched, because both `pnpm ... run test`
    and `pnpm ... test` are valid -- the root `test` script uses the second
    -- and because `-` and `:` are regex word boundaries, so a pattern loose
    enough to accept the second spelling also accepts `run test:unit`, which
    selects the right packages and runs the wrong script.

    Args:
        body (str): the script body from typescript/package.json.

    A chained body returns None rather than being segmented: the whole
    point is to name one script, and `--filter X run test && --filter Y run
    build` would otherwise read as `test` while Y's tests never ran.

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
    node: Any = workflow
    for key in ("jobs", "test", "strategy", "matrix"):
        if not isinstance(node, dict) or key not in node:
            raise SystemExit(
                f"{WORKFLOW.relative_to(REPO)}: no jobs.test.strategy.matrix "
                f"(stopped at {key!r}); the job or its matrix was renamed, "
                f"and this gate cannot see the leg table any more")
        node = node[key]
    if "leg" not in node:
        raise SystemExit(
            f"{WORKFLOW.relative_to(REPO)}: jobs.test.strategy.matrix has no "
            f"`leg` dimension; this gate cannot see the leg table any more")
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

    The root `test` script selects `./packages/*` and the manifest sets
    `pnpm.requiredScripts: ["test"]`, so such a member is not merely
    untested by the legs -- it makes `pnpm test` fail outright for every
    developer with `RECURSIVE_RUN_NO_SCRIPT`.

    Args:
        members (dict[str, bool]): package name to whether it has a test.

    Returns:
        One line per member missing a test script.
    """
    return [
        f"{name} declares no `test` script; the root `test` script selects "
        f"./packages/* and pnpm.requiredScripts lists `test`, so this breaks "
        f"`pnpm test` for everyone as well as going unclaimed by any leg"
        for name, has_test in sorted(members.items()) if not has_test
    ]


def runs_command(step: dict[str, Any], command: str) -> bool:
    """Whether a step actually executes `command`.

    Mentioning it is not running it, and the difference is the whole point:
    a shell comment, an `echo` quoting it, a step turned off with
    `if: false` or one allowed to fail all leave the text in place while
    nothing runs. Same rule, and deliberately the same shape, as
    `check_skip_hooks.py`.

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

    Everything else here assumes the workflow invokes
    `test:leg:${{ matrix.leg }}` and lets it fail the run. Nothing asserted
    that, so deleting the step, hardcoding one leg, disabling the step or
    marking it (or the job) allowed-to-fail each left a green gate over a
    job that tested nothing -- the exact silent-coverage-loss this file
    exists to refuse.

    Args:
        job (dict[str, Any]): the parsed `test` job.

    Returns:
        One line per way the invocation is absent or defanged.
    """
    wanted = LEG_PREFIX + "${{ matrix.leg }}"
    problems: list[str] = []
    if job.get("continue-on-error") is True:
        problems.append(
            "the `test` job is `continue-on-error: true`, so every leg "
            "reports success whatever its tests do and test-typescript-gate "
            "goes green over a red run")
    if not any(runs_command(step, wanted) for step in job.get("steps", [])):
        problems.append(
            f"no step runs `{wanted}` on a live line that can fail the job; "
            f"a step that is absent, `if: false`, `continue-on-error: true` "
            f"or only mentions it in a comment all leave the legs selected "
            f"by the matrix and then never invoked")
    return problems


def audit_gates(matrix: dict[str, Any], gated: dict[str,
                                                    list[str]]) -> list[str]:
    """Check every `if: matrix.<key>` step against the include rows.

    A step gated on a key that no include row defines is skipped on every
    leg, silently: bare truthiness on an absent key is false everywhere, so
    mistyping `examples:` as `example:` deletes a whole battery and leaves
    the run green. That is the same silent-drop this gate exists to stop,
    in the mechanism the split itself introduced.

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
            lost = ", ".join(sorted(set(row) - {"leg"})) or "nothing"
            problems.append(
                f"include row for leg {leg!r} matches no declared leg "
                f"({', '.join(matrix['leg'])}); GitHub cannot merge it into a "
                f"combination, so it becomes a spurious extra job and the leg "
                f"it was meant for loses {lost}")
        for key, value in row.items():
            if key in dims:
                continue
            where = f"leg {leg}" if leg is not None else "every leg"
            if not value:
                problems.append(
                    f"include sets `{key}: {value!r}` on {where}; a falsy "
                    f"value gates nothing, so every step behind "
                    f"`if: matrix.{key}` is skipped on every leg and the run "
                    f"still reports green")
            provided.setdefault(
                key, []).append(str(leg) if leg is not None else "all")

    for key, steps in sorted(gated.items()):
        if key in dims or key in provided:
            continue
        problems.append(
            f"step(s) {', '.join(steps)} run only `if: matrix.{key}`, which "
            f"no include row sets, so they are skipped on every leg and the "
            f"run still reports green")
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
            problems.append(
                f"matrix leg {leg!r} has no {LEG_PREFIX}{leg} script in "
                f"typescript/package.json; the job would fail on the runner "
                f'with pnpm\'s "Missing script"')
    for leg in declared:
        body = scripts.get(leg)
        if body is None:
            continue
        ran = invoked_script(body)
        if ran != "test":
            ran = ran or "no single script (the body chains commands)"
            problems.append(
                f"{LEG_PREFIX}{leg} runs {ran!r}, not `test`; it would select "
                f"the right packages and run the wrong script, and pnpm's "
                f"requiredScripts only guards the `test` verb it never "
                f"reaches")
    for leg in scripts:
        if leg not in declared:
            problems.append(
                f"script {LEG_PREFIX}{leg} is never run: {leg!r} is absent "
                f"from the matrix leg list, so every package it claims is "
                f"tested by nobody")

    claims: dict[str, list[str]] = {}
    for leg in declared:
        seen: set[str] = set()
        for token in FILTER.findall(scripts.get(leg, "")):
            if "..." in token:
                problems.append(
                    f"leg {leg!r} filters {token!r}: a `...` selector pulls "
                    f"the dependency closure back into the leg and "
                    f"re-serialises what the split exists to remove")
            name = package_of(token)
            if name in seen:
                problems.append(f"leg {leg!r} filters {name!r} more than once")
                continue
            seen.add(name)
            claims.setdefault(name, []).append(leg)

    for name, legs in sorted(claims.items()):
        if name not in packages:
            why = ("exists but declares no `test` script"
                   if name in known else "is not a workspace package")
            problems.append(
                f"leg(s) {', '.join(sorted(legs))} filter {name!r}, which "
                f"{why}")
        elif len(legs) > 1:
            problems.append(
                f"{name} is claimed by more than one leg "
                f"({', '.join(sorted(legs))}), so its tests run twice")
    for name in sorted(packages - set(claims)):
        problems.append(
            f"{name} is claimed by no leg, so CI never runs its tests")
    return problems


CORE = "@struktoai/mirage-core"
NODE = "@struktoai/mirage-node"
BOTH = {CORE, NODE}
DSH = "@struktoai/mirage-dsh"
SELFTEST_CASES: tuple[tuple[str, dict[
    str, str], list[str], set[str], set[str], str], ...] = (
        ("clean table", {
            "a": f"--filter {CORE} run test",
            "b": f"--filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH, ""),
        ("package claimed by no leg", {
            "a": f"--filter {CORE} run test"
        }, ["a"], BOTH, BOTH, "claimed by no leg"),
        ("package claimed twice", {
            "a": f"--filter {CORE} run test",
            "b": f"--filter {CORE} --filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH, "more than one leg"),
        ("filter names a package that does not exist", {
            "a": f"--filter {CORE} --filter @struktoai/mirage-ghost run test",
            "b": f"--filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH, "is not a workspace package"),
        ("filter names a package that lost its test script", {
            "a": f"--filter {CORE} --filter {DSH} run test",
            "b": f"--filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH | {DSH}, "declares no `test` script"),
        ("script the matrix never runs", {
            "a": f"--filter {CORE} run test",
            "b": f"--filter {NODE} run test"
        }, ["a"], BOTH, BOTH, "is never run"),
        ("matrix leg with no script", {
            "a": f"--filter {CORE} --filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH, "has no test:leg:b"),
        ("leg script runs the wrong verb", {
            "a": f"--filter {CORE} run build",
            "b": f"--filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH, "not `test`"),
        ("ellipsis selector", {
            "a": f"--filter {CORE}... run test",
            "b": f"--filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH, "dependency closure"),
        ("same package filtered twice in one leg", {
            "a": f"--filter {CORE} --filter {CORE} run test",
            "b": f"--filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH, "more than once"),
        ("--filter=name is read, not missed", {
            "a": f"--filter={CORE} run test",
            "b": f"--filter {NODE} run test"
        }, ["a", "b"], BOTH, BOTH, ""),
        ("a quoted name is read, not reported stale", {
            "a": f"--filter '{CORE}' run test",
            "b": f'--filter "{NODE}" run test'
        }, ["a", "b"], BOTH, BOTH, ""),
    )

MATRIX = {"node-version": ["24"], "leg": ["core", "cli"]}
GATE_CASES: tuple[tuple[str, list[dict[str, Any]], dict[str, list[str]], str],
                  ...] = (
                      ("every gated key is set", [{
                          "leg": "cli",
                          "typecheck": True
                      }], {
                          "typecheck": ["Typecheck"]
                      }, ""),
                      ("a gated key no include row sets", [], {
                          "examples": ["Examples"]
                      }, "skipped on every leg"),
                      ("a gated key set to false", [{
                          "leg": "cli",
                          "typecheck": False
                      }], {
                          "typecheck": ["Typecheck"]
                      }, "falsy value"),
                      ("a gated key set to an empty string", [{
                          "leg": "cli",
                          "examples": ""
                      }], {
                          "examples": ["Examples"]
                      }, "falsy value"),
                      ("an include row for an undeclared leg", [{
                          "leg":
                          "ghost",
                          "examples":
                          True
                      }], {
                          "examples": ["Examples"]
                      }, "matches no declared leg"),
                  )

LIVE = "pnpm run test:leg:${{ matrix.leg }}"
INVOCATION_CASES: tuple[tuple[str, dict[str, Any], str], ...] = (
    ("a step runs the selected leg", {
        "steps": [{
            "run": LIVE
        }]
    }, ""),
    ("no step runs any leg", {
        "steps": [{
            "run": "pnpm -r build"
        }]
    }, "no step runs"),
    ("a step hardcodes one leg", {
        "steps": [{
            "run": "pnpm run test:leg:core"
        }]
    }, "no step runs"),
    ("the step is allowed to fail", {
        "steps": [{
            "run": LIVE,
            "continue-on-error": True
        }]
    }, "no step runs"),
    ("the step is turned off with if: false", {
        "steps": [{
            "run": LIVE,
            "if": False
        }]
    }, "no step runs"),
    ("the step is turned off with ${{ false }}", {
        "steps": [{
            "run": LIVE,
            "if": "${{ false }}"
        }]
    }, "no step runs"),
    ("the leg is only named in a comment", {
        "steps": [{
            "run": f"# {LIVE}\necho skipped"
        }]
    }, "no step runs"),
    ("the leg is only echoed, not run", {
        "steps": [{
            "run": f'echo "{LIVE}"'
        }]
    }, "no step runs"),
    ("the whole job is allowed to fail", {
        "continue-on-error": True,
        "steps": [{
            "run": LIVE
        }]
    }, "continue-on-error: true"),
)

PACKAGE_CASES: tuple[tuple[str, dict[str, bool], str], ...] = (
    ("every package has a test", {
        "a": True,
        "b": True
    }, ""),
    ("a package with no test script", {
        "a": True,
        "b": False
    }, "declares no `test` script"),
)


def run_cases(label: str, cases: tuple[tuple[Any, ...], ...],
              call: Any) -> int:
    """Run one group of selftest fixtures.

    Args:
        label (str): the group name, printed as a heading.
        cases (tuple[tuple[Any, ...], ...]): fixtures, expectation last.
        call (Any): a function taking the fixture's leading fields.

    Returns:
        The number of fixtures that did not behave as expected.
    """
    failures = 0
    print(f"  {label}")
    for case in cases:
        name, args, expected = case[0], case[1:-1], case[-1]
        problems = call(*args)
        hit = any(expected in problem for problem in problems)
        if (hit and expected) or (not problems and not expected):
            print(f"    ok   {name}")
            continue
        failures += 1
        want = f"a problem containing {expected!r}" if expected else "none"
        print(f"    FAIL {name}: expected {want}, got {problems}")
    return failures


def selftest() -> int:
    """Prove each refusal fires before trusting the gate to be silent.

    Returns:
        0 when every fixture is classified as expected.
    """
    failures = run_cases(
        "leg table", SELFTEST_CASES,
        lambda scripts, declared, packages, known: audit(
            scripts, declared, packages, known))
    failures += run_cases(
        "matrix gates", GATE_CASES,
        lambda include, gated: audit_gates({
            **MATRIX, "include": include
        }, gated))
    failures += run_cases("invocation", INVOCATION_CASES, audit_invocation)
    failures += run_cases("packages", PACKAGE_CASES, audit_packages)
    if failures:
        print(f"\n{failures} selftest case(s) failed; the gate cannot see a "
              f"drift it claims to cover.")
        return 1
    total = (len(SELFTEST_CASES) + len(GATE_CASES) + len(INVOCATION_CASES) +
             len(PACKAGE_CASES))
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
