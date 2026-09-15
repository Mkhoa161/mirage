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
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

import harness  # noqa: E402

ROOT = harness.integ_root()
MAIN = ROOT / "runners" / "python" / "main.py"
TSX = ROOT / "node_modules" / ".bin" / "tsx"
CASE_TARGETS = ROOT / "runners" / "tools" / "check_case_targets.py"
FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"ok   {name}")
        return
    FAILURES.append(f"{name}: {detail}")
    print(f"FAIL {name}: {detail}")


def raises(fn, needle: str) -> tuple[bool, str]:
    """Whether fn() raises an error whose text contains needle.

    Args:
        fn (Callable): zero-argument callable expected to raise.
        needle (str): substring the error message must contain.

    Returns:
        tuple: (passed, detail) for check().
    """
    try:
        fn()
    except (KeyError, ValueError) as exc:
        text = str(exc)
        return needle in text, f"raised {text!r}, wanted {needle!r}"
    return False, "did not raise"


def with_manifest(mutate) -> dict:
    """A copy of targets.json with mutate applied, written to a temp root.

    Args:
        mutate (Callable): receives the parsed manifest and edits it.

    Returns:
        dict: the mutated manifest.
    """
    data = json.loads((ROOT / "targets.json").read_text())
    mutate(data)
    return data


def selftest_services_table() -> None:

    def drop_entry() -> None:
        data = with_manifest(lambda d: d["services"].pop("trello"))
        harness.validate_services(data)

    check("services: a service with no entry is rejected",
          *raises(drop_entry, "missing an entry"))

    def orphan_entry() -> None:
        data = with_manifest(lambda d: d["services"].update(
            {"nosuchsvc": {
                "python": [],
                "typescript": []
            }}))
        harness.validate_services(data)

    check("services: an entry naming no target is rejected",
          *raises(orphan_entry, "names no target"))

    def half_declared() -> None:
        data = with_manifest(
            lambda d: d["services"].update({"trello": {
                "python": []
            }}))
        harness.validate_services(data)

    check("services: an entry missing a host is rejected",
          *raises(half_declared, "must declare"))


def selftest_case_validation() -> None:
    cases = [
        {
            "id": "dup",
            "targets": ["ram"],
            "_source": "a.json"
        },
        {
            "id": "dup",
            "targets": ["ram"],
            "_source": "b.json"
        },
    ]
    check("cases: a duplicate id is rejected",
          *raises(lambda: harness.validate_cases(ROOT, cases), "duplicate"))

    unknown = [{
        "id": "solo",
        "targets": ["nosuchtarget"],
        "_source": "a.json"
    }]
    check("cases: an unknown target ref is rejected",
          *raises(lambda: harness.validate_cases(ROOT, unknown), "unknown"))

    real = harness.load_cases(ROOT)
    check("cases: the shipped battery passes both gates",
          len(real) > 0, f"loaded {len(real)} cases")


def run_main(args: list[str], env: dict) -> int:
    return run_main_out(args, env)[0]


def run_main_out(args: list[str], env: dict) -> tuple[int, str]:
    """Run the python runner, keeping stdout for an equivalence check.

    Args:
        args (list[str]): runner arguments.
        env (dict): environment overrides; an empty value unsets.

    Returns:
        tuple: exit code and stdout.
    """
    merged = {**os.environ, **env}
    for k, v in env.items():
        if v == "":
            merged.pop(k, None)
    proc = subprocess.run([sys.executable, str(MAIN), *args],
                          capture_output=True,
                          text=True,
                          env=merged)
    return proc.returncode, proc.stdout


def selftest_strict_exit() -> None:
    """The deliverable: a strict run that loses a target must not be green.

    Uses --target rather than --facet so the older all-skipped facet guard
    cannot be what fires; this pins the new per-target gate on its own.
    """
    blanked = {"TRELLO_URL": ""}
    code = run_main(["--target", "trello", "--strict"], blanked)
    check("strict: a skipped target exits non-zero", code != 0, f"exit {code}")

    code = run_main(["--target", "trello"], blanked)
    check("permissive: the same run still exits 0 for local convenience",
          code == 0, f"exit {code}")

    # The partial-skip case the facet guard cannot see: python self-hosts
    # linear, so the project facet still runs one target and ran != 0.
    code = run_main(["--facet", "project", "--strict"], blanked)
    check("strict: a facet that loses only some targets exits non-zero", code
          != 0, f"exit {code}")
    code = run_main(["--facet", "project"], blanked)
    check("permissive: that same partial facet still exits 0", code == 0,
          f"exit {code}")

    # A facet split across CI jobs declares the services it does not
    # provision; a declared skip is tolerated, a typo'd one is rejected so
    # the list cannot rot into silently widening what --strict accepts.
    code = run_main(
        ["--target", "trello", "--strict", "--allow-skip", "trello"], blanked)
    check("allow-skip: a declared skip is tolerated under --strict", code == 0,
          f"exit {code}")
    code = run_main(
        ["--target", "trello", "--strict", "--allow-skip", "nosuchsvc"],
        blanked)
    check("allow-skip: an unknown service name is rejected", code != 0,
          f"exit {code}")


SHARED_SERVICES = {"discord", "github", "http", "linear", "trello"}


def selftest_target_pool() -> None:
    """The pool may reorder work, never output, and never a shared fake.

    Three separable claims, because they fail separately. A target whose
    fake holds one world must hold that fake's lane; a target that scopes
    itself by run id must NOT, since serializing those would give the pool
    nothing to do (gws carries five core targets, s3 three, and they are
    the slow ones); and a concurrent run must print what a serial run
    printed, which is what lets a reader diff two CI logs.
    """
    data = json.loads((ROOT / "targets.json").read_text())
    services = harness.validate_services(data)
    alone, pool = harness.plan_run(data["targets"], services)

    targets = data["targets"]
    named = [targets[i]["id"] for i in alone]
    check("pool: only a process-global opener runs alone", named == ["opfs"],
          f"ran alone: {named}")

    lanes = {lane for _, lane in pool if not lane.startswith("solo:")}
    check("pool: exactly the one-world fakes hold a lane",
          lanes == SHARED_SERVICES, f"lanes: {sorted(lanes)}")

    scoped = [lane for i, lane in pool if targets[i].get("service") == "gws"]
    check("pool: a run-scoped service does not serialize its own targets",
          len(scoped) > 1 and all(la.startswith("solo:") for la in scoped),
          f"gws lanes: {scoped}")

    # The accident this whole mechanism exists for. `github` is safe in the
    # core facet today only because that facet holds exactly one github
    # target, which is a property of the data and not of the code. A second
    # one must land in the same lane rather than pool beside the first.
    twinned = with_manifest(lambda d: d["targets"].append({
        **next(t for t in d["targets"] if t["id"] == "github"), "id":
        "github-twin"
    }))
    _, twin_pool = harness.plan_run(twinned["targets"], services)
    twin_lanes = [
        lane for i, lane in twin_pool
        if twinned["targets"][i]["id"].startswith("github")
    ]
    check("pool: two targets on a one-world fake share its lane",
          len(twin_lanes) == 2 and set(twin_lanes) == {"github"},
          f"lanes: {twin_lanes}")

    def unknown_key() -> None:
        harness.validate_services(
            with_manifest(
                lambda d: d["services"]["trello"].update({"nosuchkey": True})))

    check("services: an unknown key on a service entry is rejected",
          *raises(unknown_key, "unknown key"))

    code = run_main(["--target", "ram", "--target-jobs", "0"], {})
    check("--target-jobs below one is refused", code == 2, f"exit {code}")

    # The equivalence itself, end to end. argerr is the one multi-target
    # facet that needs no service at all, so this costs a few seconds.
    serial_code, serial_out = run_main_out(["--facet", "argerr", "--strict"],
                                           {})
    pool_code, pool_out = run_main_out(
        ["--facet", "argerr", "--strict", "--target-jobs", "4"], {})
    check("pool: a concurrent run exits as the serial run did",
          serial_code == 0 and pool_code == 0,
          f"serial {serial_code}, pool {pool_code}")
    check("pool: a concurrent run prints what the serial run printed",
          serial_out == pool_out and serial_out != "",
          f"{len(serial_out)} vs {len(pool_out)} chars")


def run_case_targets(root: Path) -> int:
    """Run the case-target gate under --strict against a scratch tree.

    Args:
        root (Path): repo root the gate should read.

    Returns:
        int: the gate's exit code.
    """
    result = subprocess.run(
        [sys.executable, str(CASE_TARGETS), "--strict"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    return result.returncode


def selftest_case_targets() -> None:
    """A dropped target must move the count, in both directions.

    This gate exists because a backend that cannot pass a case is normally
    just deleted from that case's ``targets``, so the check that matters is
    that the committed tree is *on* its baseline and that either edge --
    one more omission, or one fewer -- is a failure rather than a quieter
    number nobody reads.
    """
    check("case targets: the committed tree sits on its baseline",
          run_case_targets(ROOT.parent) == 0)

    exceptions = ROOT / "target_exceptions.json"
    original = exceptions.read_text()
    loaded = json.loads(original)
    baseline = loaded["baseline"]
    try:
        loaded["baseline"] = baseline + 1
        exceptions.write_text(json.dumps(loaded, indent=2) + "\n")
        check("case targets: a baseline above the real count fails",
              run_case_targets(ROOT.parent) != 0)
        loaded["baseline"] = baseline - 1
        exceptions.write_text(json.dumps(loaded, indent=2) + "\n")
        check("case targets: a baseline below the real count fails",
              run_case_targets(ROOT.parent) != 0)
        loaded["baseline"] = baseline
        loaded["files"] = {"integ/unix/mv/empty_dir.json": "no longer a gap"}
        exceptions.write_text(json.dumps(loaded, indent=2) + "\n")
        check("case targets: a stale exception fails",
              run_case_targets(ROOT.parent) != 0)
    finally:
        exceptions.write_text(original)


def run_typescript(args: list[str], env: dict) -> tuple[int, str]:
    """Run the typescript runner, keeping stderr for the failure message.

    An unbuilt mirage package makes the runner die on import with an exit
    code that looks exactly like a gate verdict, so the tail of stderr
    rides along and says which of the two it was.

    Args:
        args (list[str]): runner arguments.
        env (dict): environment overrides; an empty value unsets.

    Returns:
        tuple: exit code and the last line of stderr.
    """
    merged = {**os.environ, **env}
    for k, v in env.items():
        if v == "":
            merged.pop(k, None)
    proc = subprocess.run([str(TSX), "runners/typescript/main.ts", *args],
                          capture_output=True,
                          text=True,
                          cwd=ROOT,
                          env=merged)
    lines = [ln for ln in proc.stderr.splitlines() if ln.strip()]
    errors = [ln for ln in lines if "Error" in ln or "error" in ln]
    return proc.returncode, (errors[0] if errors else
                             (lines[-1] if lines else ""))


def ts_stdout(args: list[str]) -> str:
    """The typescript runner's stdout, for the pool equivalence check.

    Args:
        args (list[str]): runner arguments.

    Returns:
        str: stdout, or empty when the runner failed.
    """
    proc = subprocess.run([str(TSX), "runners/typescript/main.ts", *args],
                          capture_output=True,
                          text=True,
                          cwd=ROOT)
    return proc.stdout if proc.returncode == 0 else ""


# Minted back to back, the way the pool starts targets. A clock reading is
# unique only when the caller is slower than its resolution, which the
# serial loop was and the pool is not. Dynamic import because `tsx --eval`
# compiles as cjs, where a top-level await does not parse.
RUN_ID_PROBE = (
    "import('./runners/typescript/adapters/index.ts').then((m) => {\n"
    "  const ids = Array.from({ length: 8 }, () => m.runId())\n"
    "  console.log(new Set(ids).size)\n"
    "})\n")


def selftest_run_ids() -> None:
    """Two pooled targets must never be handed one namespace.

    Every backend builds its world out of the run id -- a ``/_run/<id>``
    path on gws, an s3 key prefix, a gridfs database, a dropbox account --
    so a shared one is two targets seeding and resetting each other. The
    typescript host minted ``${pid}-${Date.now()}``, which the serial loop
    made unique by being slower than a millisecond and the pool is not:
    five targets started in one tick took one id.
    """
    proc = subprocess.run([str(TSX), "--eval", RUN_ID_PROBE],
                          capture_output=True,
                          text=True,
                          cwd=ROOT)
    check("run ids: eight minted in one tick are distinct (ts)",
          proc.stdout.strip() == "8",
          f"distinct: {proc.stdout.strip()!r} {proc.stderr[-200:]}")


def selftest_typescript_gates(require: bool) -> None:
    """The same two exits on the typescript host, so the gate is symmetric.

    A silent skip here would be the very thing this file exists to catch —
    a check that reports success having run nothing — so CI passes
    --require-ts and a missing tsx is a failure rather than a skip.

    Args:
        require (bool): whether an absent tsx fails instead of skipping.
    """
    if not TSX.is_file():
        if require:
            check("typescript gates ran", False,
                  f"--require-ts given but {TSX} is missing")
            return
        print("skip typescript gates: no tsx (run pnpm install from "
              "typescript/)")
        return
    # Prove the runner starts before reading exit codes as verdicts: an
    # unbuilt mirage package dies on import with a non-zero code, which
    # would make the strict assertion below pass for the wrong reason. An
    # unknown facet exits 2 without running any case, so it costs nothing.
    code, err = run_typescript(["--facet", "__selftest_no_such_facet__"], {})
    check("typescript runner starts (packages built)", code == 2,
          f"exit {code}: {err}")

    blanked = {"TRELLO_URL": ""}
    code, err = run_typescript(["--target", "trello", "--strict"], blanked)
    check("strict (ts): a skipped target exits non-zero", code != 0,
          f"exit {code}: {err}")
    code, err = run_typescript(["--target", "trello"], blanked)
    check("permissive (ts): the same run still exits 0", code == 0,
          f"exit {code}: {err}")
    selftest_run_ids()

    code, err = run_typescript(["--target", "ram", "--target-jobs"], {})
    check("--target-jobs with no value is refused (ts)", code == 2,
          f"exit {code}: {err}")

    # The pool's two claims on this host too. The equivalence needs stdout,
    # which run_typescript drops in favour of stderr, so it spawns its own.
    code, err = run_typescript(["--target", "ram", "--target-jobs", "0"], {})
    check("--target-jobs below one is refused (ts)", code == 2,
          f"exit {code}: {err}")
    serial = ts_stdout(["--facet", "argerr", "--strict"])
    pooled = ts_stdout(["--facet", "argerr", "--strict", "--target-jobs", "4"])
    check("pool (ts): a concurrent run prints what the serial run printed",
          serial == pooled and serial != "",
          f"{len(serial)} vs {len(pooled)} chars")


def main() -> None:
    selftest_services_table()
    selftest_case_validation()
    selftest_strict_exit()
    selftest_target_pool()
    selftest_case_targets()
    selftest_typescript_gates("--require-ts" in sys.argv)
    print()
    if FAILURES:
        print(f"{len(FAILURES)} gate(s) failed", file=sys.stderr)
        sys.exit(1)
    print("all integ runner gates hold")


if __name__ == "__main__":
    main()
