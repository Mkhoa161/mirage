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

import pytest

from mirage.types import DEFAULT_READ_TTL, ReadPolicy, ReadSpec
from mirage.vfs.aliyun.aliyun import AliyunVFS
from mirage.vfs.backblaze.backblaze import BackblazeVFS
from mirage.vfs.ceph.ceph import CephVFS
from mirage.vfs.digitalocean.digitalocean import DigitalOceanVFS
from mirage.vfs.disk.disk import DiskVFS
from mirage.vfs.gcs.gcs import GCSVFS
from mirage.vfs.gridfs.gridfs import GridFSVFS
from mirage.vfs.hf_buckets import HfBucketsConfig, HfBucketsVFS
from mirage.vfs.minio.config import MinIOConfig
from mirage.vfs.minio.minio import MinIOVFS
from mirage.vfs.oci.oci import OCIVFS
from mirage.vfs.qingstor.qingstor import QingStorVFS
from mirage.vfs.r2.r2 import R2VFS
from mirage.vfs.ram.ram import RAMVFS
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.vfs.scaleway.scaleway import ScalewayVFS
from mirage.vfs.seaweedfs.seaweedfs import SeaweedFSVFS
from mirage.vfs.ssh.ssh import SSHVFS, SSHConfig
from mirage.vfs.supabase.supabase import SupabaseVFS
from mirage.vfs.tencent.tencent import TencentVFS
from mirage.vfs.wasabi.wasabi import WasabiVFS
from mirage.workspace.mount.read_policy import (check_read_capability,
                                                coerce_read_policy,
                                                resolve_read_spec)

FRESH = ReadSpec(policy=ReadPolicy.FRESH)

# Every S3-compatible provider reaches the verdict through S3VFS, so the
# flag is declared once and inherited. Listing them is what catches a new
# provider that stops inheriting.
S3_ALIASES = [
    AliyunVFS, BackblazeVFS, CephVFS, DigitalOceanVFS, GCSVFS, MinIOVFS,
    OCIVFS, QingStorVFS, R2VFS, ScalewayVFS, SeaweedFSVFS, SupabaseVFS,
    TencentVFS, WasabiVFS
]


def test_absent_policy_is_bounded_at_the_default_bound():
    assert resolve_read_spec(None, None) == ReadSpec(policy=ReadPolicy.BOUNDED,
                                                     ttl=DEFAULT_READ_TTL)


def test_empty_policy_reads_as_absent():
    assert resolve_read_spec("", None).policy is ReadPolicy.BOUNDED


def test_an_already_coerced_policy_passes_through():
    # str() of a (str, Enum) member is "ReadPolicy.BOUNDED", so a second
    # coercion of an already-coerced value would refuse it. The config
    # door validates the field and then builds the spec, so it happens.
    assert coerce_read_policy(ReadPolicy.FRESH) is ReadPolicy.FRESH
    assert resolve_read_spec(ReadPolicy.BOUNDED,
                             30) == ReadSpec(policy=ReadPolicy.BOUNDED, ttl=30)


def test_policy_name_is_case_insensitive():
    assert resolve_read_spec("FRESH", None).policy is ReadPolicy.FRESH


def test_declared_bound_is_kept():
    assert resolve_read_spec("bounded", 30).ttl == 30


def test_a_bound_must_be_whole_positive_seconds():
    """A zero or negative bound is an entry that is stale the instant
    it is written, and a float or a bool is a bound the store cannot
    compare against; the coercer is the one place that can say so
    before a mount installs."""
    for bad in (0, -1, -600):
        with pytest.raises(ValueError, match="at least 1 second"):
            resolve_read_spec("bounded", bad)
    for junk in (1.5, True, "600"):
        with pytest.raises(ValueError, match="whole seconds"):
            resolve_read_spec("bounded", junk)


def test_unknown_policy_names_the_known_ones():
    with pytest.raises(ValueError) as exc:
        resolve_read_spec("banana", None)
    assert "fresh, bounded, pinned" in str(exc.value)


def test_pinned_is_refused_naming_the_missing_layer():
    with pytest.raises(ValueError) as exc:
        check_read_capability("/d/", RAMVFS(),
                              ReadSpec(policy=ReadPolicy.PINNED))
    assert "needs a version layer to pin to" in str(exc.value)
    assert "use fresh or bounded" in str(exc.value)


def test_fresh_is_refused_on_ram_which_cannot_cache_reads():
    with pytest.raises(ValueError) as exc:
        check_read_capability("/d/", RAMVFS(), FRESH)
    assert "needs a resource that caches reads" in str(exc.value)
    assert "ram does not" in str(exc.value)


def test_fresh_is_refused_on_disk_which_cannot_cache_reads(tmp_path):
    vfs = DiskVFS(root=str(tmp_path))
    with pytest.raises(ValueError) as exc:
        check_read_capability("/local/", vfs, FRESH)
    assert "needs a resource that caches reads" in str(exc.value)


def test_fresh_is_refused_on_a_backend_that_caches_but_stamps_nothing():
    # hf_buckets reaches the gate -- it caches reads -- but its read
    # record carries no fingerprint, so there is nothing to compare.
    vfs = HfBucketsVFS(HfBucketsConfig(bucket="acme/data"))
    assert vfs.caches_reads is True
    with pytest.raises(ValueError) as exc:
        check_read_capability("/hf/", vfs, FRESH)
    assert "comparable content token" in str(exc.value)


def test_fresh_is_refused_on_ssh_rather_than_warned():
    # #1101 Q8 recommended warn-and-serve on the grounds that ssh's mtime
    # is forgeable but usable. It is worse than that: ssh stamps no read
    # fingerprint at all, so a cached entry holds md5(content) against an
    # mtime stat token and fresh would refetch on every read, forever.
    vfs = SSHVFS(SSHConfig(host="h", username="u"))
    assert vfs.caches_reads is True
    with pytest.raises(ValueError) as exc:
        check_read_capability("/r/", vfs, FRESH)
    assert "comparable content token" in str(exc.value)


def test_fresh_is_allowed_on_s3():
    vfs = S3VFS(S3Config(bucket="b"))
    assert check_read_capability("/s3/", vfs, FRESH) is None


def test_fresh_is_allowed_on_a_constructed_alias():
    vfs = MinIOVFS(
        MinIOConfig(bucket="b", endpoint_url="http://127.0.0.1:9000"))
    assert check_read_capability("/m/", vfs, FRESH) is None


@pytest.mark.parametrize("cls", S3_ALIASES, ids=lambda c: c.__name__)
def test_every_s3_alias_inherits_the_capability(cls):
    assert cls.READ_REVALIDATABLE is True
    assert cls.caches_reads is True


def test_gridfs_declares_the_capability():
    assert GridFSVFS.READ_REVALIDATABLE is True


def test_bounded_is_allowed_on_a_backend_that_cannot_revalidate():
    assert check_read_capability("/d/", RAMVFS(), ReadSpec()) is None
