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

import asyncio
from contextlib import ExitStack

import pytest

from mirage.observe.context import RecordingScope
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.e2e.mounts import REDIS_URL, SSH_ROOT, _build_mount, _MountState
from tests.e2e.s3_mock import patch_s3_multi

# The key lives under a directory named like its mount (/m/m/k.txt), the one
# shape that tells "records the virtual path" apart from "records the
# mount-relative path and lets the prefix guess repair it": the guess sees
# /m/k.txt already under /m and leaves it alone.
SCRIPT = [
    "echo x > /m/m/k.txt",
    "echo y >> /m/m/k.txt",
    "echo z | tee -a /m/m/k.txt",
    "touch /m/m/new.txt",
    "truncate -s 0 /m/m/new.txt",
    "cat /m/m/k.txt",
    "cp /m/m/k.txt /r/k.txt",
    "cp /m/m/k.txt /m/m/k2.txt",
    "mv /m/m/new.txt /m/m/moved.txt",
    "rm /m/m/moved.txt",
    "mkdir /m/m/e; rmdir /m/m/e",
    "mkdir /m/m/d; touch /m/m/d/f; rm -r /m/m/d",
]

# Namespace ops record at the door with the virtual path already, so they
# cannot tell the two behaviours apart; exempt by op name, not by source.
EXEMPT_OPS = {
    "setattr",
    "symlink",
    "readlink",
    "getxattr",
    "listxattr",
    "setxattr",
    "removexattr",
}

K = "/m/m/k.txt"
NEW = "/m/m/new.txt"
DF = "/m/m/d/f"
C = "/m/m/c.txt"

# Op sequences were measured by running SCRIPT on each backend; every path is
# predicted as the operand's virtual path, never copied from the measurement.
# ram, disk and redis record nothing for same-mount cp/mv/rm/rmdir/rm -r.
_NATIVE_APPEND = [
    ("write", K),
    ("read", K),
    ("write", K),
    ("append", K),
    ("write", NEW),
    ("truncate", NEW),
    ("read", K),
    ("read", K),
    ("write", DF),
    ("create", C),
    ("append", C),
]

# s3 has no native append (read + write), serves cat and the cp source from
# cache, and records its own copy, rename, unlink, rmdir and rm_r.
_S3 = [
    ("write", K),
    ("read", K),
    ("write", K),
    ("read", K),
    ("write", K),
    ("write", NEW),
    ("truncate", NEW),
    ("copy", "/m/m/k2.txt"),
    ("rename", NEW),
    ("rename", "/m/m/moved.txt"),
    ("unlink", "/m/m/moved.txt"),
    ("rmdir", "/m/m/e"),
    ("write", DF),
    ("rm_r", "/m/m/d"),
    ("create", C),
    ("read", C),
    ("write", C),
]

# ssh records nothing for tee -a, cat (cached), cp, mv, rm, rmdir, rm -r or
# the op-door append.
_SSH = [
    ("write", K),
    ("read", K),
    ("write", K),
    ("write", NEW),
    ("truncate", NEW),
    ("write", DF),
    ("create", C),
]

EXPECTED = {
    "ram": _NATIVE_APPEND,
    "disk": _NATIVE_APPEND,
    "redis": _NATIVE_APPEND,
    "s3": _S3,
    "ssh": _SSH,
}

S3_BUCKET = "test-bucket-1"


def _under_m(path: str) -> bool:
    return path == "/m" or path.startswith("/m/")


def _ledger(records) -> list[tuple[str, str]]:
    return [(r.op, r.path) for r in records
            if _under_m(r.path) and r.op not in EXEMPT_OPS]


async def _prepare(ws: Workspace, state: _MountState) -> None:
    if state.ptype == "ssh":
        state.sftp_dirs.add(f"{SSH_ROOT}/m")
    elif state.ptype != "s3":
        io = await ws.shell("mkdir -p /m/m")
        assert io.exit_code == 0


async def _run_row(state: _MountState) -> list[tuple[str, str]]:
    ws = Workspace(
        {
            "/m": (state.vfs, MountMode.WRITE),
            "/r": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    try:
        await _prepare(ws, state)
        ws._ops.records.clear()
        for line in SCRIPT:
            io = await ws.shell(line)
            await io.stdout_str()
            # A fake that fails an op silently would drop its record; the
            # exit code catches that before the ledger does.
            assert io.exit_code == 0, (line, await io.stderr_str())
        records = list(ws._ops.records)
        # The op door is the only way to reach the create sites (touch
        # records write); its records land in the scope, not ws._ops.
        scope = RecordingScope()
        try:
            path = PathSpec.from_str_path(C)
            await ws.dispatch("create", path)
            await ws.dispatch("append", path, data=b"q")
        finally:
            scope.close()
        records.extend(scope.records)
        return _ledger(records)
    finally:
        if state.ptype == "redis":
            await state.vfs._store.clear()
        await ws.close()


def _row_marks(ptype: str):
    if ptype == "redis" and not REDIS_URL:
        return [pytest.mark.skip(reason="REDIS_URL not set")]
    return []


@pytest.mark.parametrize(
    "ptype", [pytest.param(p, id=p, marks=_row_marks(p)) for p in EXPECTED])
def test_record_paths_are_virtual(ptype, tmp_path):
    state = _build_mount(ptype, "/m", tmp_path, 1)
    with ExitStack() as stack:
        if ptype == "s3":
            stack.enter_context(patch_s3_multi({S3_BUCKET: {}}))
        # One loop per row: FakeRedis and pooled clients break across loops.
        ledger = asyncio.run(_run_row(state))
    assert ledger == EXPECTED[ptype]
