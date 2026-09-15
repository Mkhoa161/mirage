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


def stat_fingerprint(etag: str | None, modified: str | None,
                     size: int | None) -> str:
    """Mirage's default content fingerprint from listing metadata.

    Every field the listing carries, joined: the backend's native
    version (ETag/rev), the last-modified stamp and the size. Distinct
    from ``mirage.cache.file.utils.default_fingerprint``, which hashes
    the content bytes themselves.

    All three, not the ETag alone, because **an ETag can be coarser
    than the content it versions**. Probed against Nextcloud 30: its
    WebDAV ETag is derived from an mtime with one-second granularity,
    so two writes inside the same second share one ETag even when the
    size changes (4 bytes to 11 in the probe, 23 of 25 rewrites
    identical at 0s apart, 0 of 6 at 1.1s apart). Returning the ETag
    alone threw away the size, which had changed and was sitting right
    there, and the update went undetected -- intermittently, since
    whether the two writes land in one second is a matter of how fast
    the machine is. A composite can only ever detect more: a component
    that does not move contributes nothing, and any one that moves is
    enough.

    Args:
        etag (str | None): Native version identifier, if any.
        modified (str | None): Last-modified stamp.
        size (int | None): Content size in bytes.
    """
    return f"{etag or ''}|{modified or ''}|{size}"
