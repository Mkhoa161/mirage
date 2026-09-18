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
import gzip
import io
import tarfile
import zipfile

import pytest

from mirage.types import MountMode
from mirage.vfs import RAMVFS
from mirage.workspace import Workspace


def _tgz_bytes() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name in ("./memory/memory.json", "./other.txt"):
            info = tarfile.TarInfo(name=name)
            data = f"content:{name}\n".encode()
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return gzip.compress(buf.getvalue())


def _zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("memory/memory.json", "zipped\n")
    return buf.getvalue()


@pytest.fixture()
def ws() -> Workspace:
    work = RAMVFS()
    work._store.files["/files.tar.gz"] = _tgz_bytes()
    work._store.files["/files.zip"] = _zip_bytes()
    return Workspace(mounts={
        "/": (RAMVFS(), MountMode.WRITE),
        "/work/": (work, MountMode.WRITE),
    })


def _run(ws: Workspace, line: str):
    return asyncio.run(ws.execute(line))


def test_tar_selector_does_not_join_routing(ws):
    # cwd is /, the archive is on /work: the selector must not count as
    # a path operand or the line refuses as a cross-mount span.
    result = _run(ws, "tar -xOzf /work/files.tar.gz ./memory/memory.json")
    assert result.exit_code == 0
    assert result.stdout == b"content:./memory/memory.json\n"


def test_tar_extract_lands_in_cwd_across_mounts(ws):
    result = _run(ws, "tar -xzf /work/files.tar.gz")
    assert result.exit_code == 0
    out = _run(ws, "cat /memory/memory.json")
    assert out.stdout == b"content:./memory/memory.json\n"


def test_tar_extract_dash_C_into_another_mount(ws):
    result = _run(ws, "tar -xzf /work/files.tar.gz -C /dest")
    assert result.exit_code == 0
    out = _run(ws, "cat /dest/memory/memory.json")
    assert out.stdout == b"content:./memory/memory.json\n"


def test_tar_create_span_keeps_the_refusal(ws):
    _run(ws, "mkdir -p /src && echo hi > /src/f.txt")
    result = _run(ws, "tar -czf /work/backup.tgz /src")
    assert result.exit_code == 1
    assert b"paths span multiple mounts" in result.stderr


def test_unzip_extracts_into_cwd(ws):
    _run(ws, "cd /")
    result = _run(ws, "unzip -q /work/files.zip")
    assert result.exit_code == 0
    out = _run(ws, "cat /memory/memory.json")
    assert out.stdout == b"zipped\n"


def test_unzip_dash_d_into_another_mount(ws):
    result = _run(ws, "unzip -q -d /dest /work/files.zip")
    assert result.exit_code == 0
    out = _run(ws, "cat /dest/memory/memory.json")
    assert out.stdout == b"zipped\n"
