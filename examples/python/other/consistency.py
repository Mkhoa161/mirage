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
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.types import ConsistencyPolicy
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS

try:
    from mirage.vfs.redis import RedisVFS
    _REDIS_IMPORT_OK = True
except ImportError:
    RedisVFS = None
    _REDIS_IMPORT_OK = False


def _banner(title: str) -> None:
    print(f"\n=== {title} ===")


async def disk_demo() -> None:
    """Disk has mtime fingerprints. ALWAYS detects external mutation."""
    _banner("disk + LAZY — external mutation NOT detected (cached stale)")
    lazy_root = Path(tempfile.mkdtemp(prefix="mirage-disk-lazy-"))
    try:
        (lazy_root / "file.txt").write_bytes(b"v1")
        vfs = DiskVFS(root=str(lazy_root))
        ws = Workspace(
            {"/data": (vfs, MountMode.WRITE)},
            mode=MountMode.WRITE,
            consistency=ConsistencyPolicy.LAZY,
        )
        io1 = await ws.execute("cat /data/file.txt")
        print(f"  first  read (v1 expected)        : "
              f"{(await io1.materialize_stdout())!r}")
        time.sleep(1.1)
        (lazy_root / "file.txt").write_bytes(b"v2-external")
        io2 = await ws.execute("cat /data/file.txt")
        print(f"  second read after external write : "
              f"{(await io2.materialize_stdout())!r}  <-- LAZY, stale")
    finally:
        shutil.rmtree(lazy_root, ignore_errors=True)

    _banner("disk + ALWAYS — external mutation detected (fresh)")
    always_root = Path(tempfile.mkdtemp(prefix="mirage-disk-always-"))
    try:
        (always_root / "file.txt").write_bytes(b"v1")
        vfs = DiskVFS(root=str(always_root))
        ws = Workspace(
            {"/data": (vfs, MountMode.WRITE)},
            mode=MountMode.WRITE,
            consistency=ConsistencyPolicy.ALWAYS,
        )
        io1 = await ws.execute("cat /data/file.txt")
        print(f"  first  read (v1 expected)        : "
              f"{(await io1.materialize_stdout())!r}")
        time.sleep(1.1)
        (always_root / "file.txt").write_bytes(b"v2-external")
        io2 = await ws.execute("cat /data/file.txt")
        print(f"  second read after external write : "
              f"{(await io2.materialize_stdout())!r}  <-- ALWAYS, fresh")
    finally:
        shutil.rmtree(always_root, ignore_errors=True)


async def ram_demo() -> None:
    """RAM has no fingerprint. ALWAYS falls back to LAZY.

    Workspace-originated writes still invalidate the cache.
    """
    _banner("RAM + ALWAYS — no fingerprint, LAZY fallback serves stale")
    vfs = RAMVFS()
    vfs._store.files["/file.txt"] = b"v1"
    ws = Workspace(
        {"/data": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )
    io1 = await ws.execute("cat /data/file.txt")
    print(f"  first  read (v1 expected)              : "
          f"{(await io1.materialize_stdout())!r}")
    vfs._store.files["/file.txt"] = b"v2-external"
    io2 = await ws.execute("cat /data/file.txt")
    print(f"  second read after external mutation    : "
          f"{(await io2.materialize_stdout())!r}  <-- ALWAYS→LAZY, stale")

    _banner("RAM — workspace-originated write invalidates cache (fresh)")
    vfs2 = RAMVFS()
    vfs2._store.files["/file.txt"] = b"v1"
    ws2 = Workspace(
        {"/data": (vfs2, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.ALWAYS,
    )
    io3 = await ws2.execute("cat /data/file.txt")
    print(f"  first read (v1 expected)               : "
          f"{(await io3.materialize_stdout())!r}")
    await ws2.execute('echo -n "v2-via-workspace" > /data/file.txt')
    io4 = await ws2.execute("cat /data/file.txt")
    print(f"  read after workspace-owned write       : "
          f"{(await io4.materialize_stdout())!r}  <-- cache invalidated")


async def redis_demo() -> None:
    if not _REDIS_IMPORT_OK:
        _banner("redis — SKIPPED (mirage-ai[redis] extra not installed)")
        return
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    prefix = f"mirage_consistency_demo_{uuid.uuid4().hex[:8]}"

    _banner("redis + ALWAYS — no fingerprint, LAZY fallback serves stale")
    try:
        vfs = RedisVFS(url=redis_url, key_prefix=prefix)
    except Exception as exc:
        print(f"  SKIPPED (could not connect to {redis_url}): {exc}")
        return

    # Prime: write v1 through the workspace so it lands in the VFS
    ws_primer = Workspace(
        {"/data": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        consistency=ConsistencyPolicy.LAZY,
    )
    await ws_primer.execute('echo -n "v1" > /data/file.txt')
    try:
        ws = Workspace(
            {"/data": (vfs, MountMode.WRITE)},
            mode=MountMode.WRITE,
            consistency=ConsistencyPolicy.ALWAYS,
        )
        io1 = await ws.execute("cat /data/file.txt")
        print(f"  first  read (v1 expected)              : "
              f"{(await io1.materialize_stdout())!r}")

        # Simulate external mutation: write directly through another workspace
        # instance. The target cache (ws._cache) never sees the other write,
        # so it still serves v1 under ALWAYS (no fingerprint to compare).
        ws_other = Workspace(
            {
                "/data":
                (RedisVFS(url=redis_url, key_prefix=prefix), MountMode.WRITE)
            },
            mode=MountMode.WRITE,
        )
        await ws_other.execute('echo -n "v2-external" > /data/file.txt')

        io2 = await ws.execute("cat /data/file.txt")
        print(f"  second read after external mutation    : "
              f"{(await io2.materialize_stdout())!r}  <-- ALWAYS→LAZY, stale")

        # Workspace-owned write invalidates the local cache
        _banner("redis — workspace-originated write invalidates cache (fresh)")
        await ws.execute('echo -n "v3-via-workspace" > /data/file.txt')
        io3 = await ws.execute("cat /data/file.txt")
        print(f"  read after workspace-owned write       : "
              f"{(await io3.materialize_stdout())!r}  <-- cache invalidated")
    finally:
        # Clean up keys we created
        try:
            import redis
            client = redis.Redis.from_url(redis_url)
            for key in client.scan_iter(match=f"{prefix}:*"):
                client.delete(key)
        except Exception:
            pass


async def main() -> None:
    await disk_demo()
    await ram_demo()
    await redis_demo()


if __name__ == "__main__":
    asyncio.run(main())
