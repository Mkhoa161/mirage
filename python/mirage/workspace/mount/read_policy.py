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

from mirage.types import DEFAULT_READ_TTL, ReadPolicy, ReadSpec
from mirage.vfs.base import BaseVFS


def resolve_read_spec(policy: "str | ReadPolicy | None",
                      ttl: int | None) -> ReadSpec:
    """Coerce a declared read policy and bound into a ReadSpec.

    Coercion only: an unknown name is refused here, but whether the
    resolved policy is one this mount's backend can honour is
    ``check_read_capability``'s question. The two are split the way
    ``fuse/backend.py`` splits ``resolve_backend`` from
    ``require_kernel_backend``, so the config door and the mount door
    each run exactly one of them and a refusal is computed once.

    Missing means bounded at the default bound, everywhere: an absent
    ``read:`` in YAML, ``None`` here, and the ``Mount`` dataclass
    default all resolve to the same thing.

    Args:
        policy (str | ReadPolicy | None): the requested policy; None
            and the empty string mean bounded.
        ttl (int | None): the requested bound in seconds; None means
            the default.

    Returns:
        ReadSpec: the resolved policy and bound.

    Raises:
        ValueError: the policy name is not a known one.
    """
    if policy is None or policy == "":
        resolved = ReadPolicy.BOUNDED
    else:
        try:
            resolved = ReadPolicy(str(policy).lower())
        except ValueError:
            known = ", ".join(p.value for p in ReadPolicy)
            raise ValueError(
                f"unknown read policy {policy!r}; expected one of: {known}")
    return ReadSpec(policy=resolved,
                    ttl=DEFAULT_READ_TTL if ttl is None else ttl)


def check_read_capability(prefix: str, vfs: BaseVFS, spec: ReadSpec) -> None:
    """Refuse a read policy this mount's backend cannot honour.

    The rules are ordered, and the order is the answer to two questions
    that collide on a disk mount: whether the gate can fire at all, and
    whether the token behind it is worth comparing. A backend that does
    not cache reads is answered by the first and never reaches the
    second.

    A policy that cannot act must say so. Degrading ``fresh`` to
    ``bounded`` on a backend that cannot revalidate is the silent
    downgrade this whole policy exists to remove, so it is a refusal at
    mount time rather than a warning at read time.

    Args:
        prefix (str): the mount prefix, for the message.
        vfs (BaseVFS): the backend being mounted.
        spec (ReadSpec): the resolved policy and bound.

    Raises:
        ValueError: the backend cannot honour the declared policy.
    """
    if spec.policy is ReadPolicy.PINNED:
        raise ValueError(
            f"mount {prefix!r}: read: pinned needs a version layer to pin "
            "to, and mirage has none; use fresh or bounded")
    if spec.policy is not ReadPolicy.FRESH:
        return
    # VFSName is a (str, Enum), whose str() is "VFSName.RAM"; a VFS
    # registered from a script carries a plain string. Both read as the
    # wire name through .value.
    name = getattr(vfs.name, "value", vfs.name)
    # The instance attribute, not the class: lancedb decides per config
    # whether it caches reads.
    if not vfs.caches_reads:
        raise ValueError(
            f"mount {prefix!r}: read: fresh needs a resource that caches "
            f"reads; {name} does not, so the freshness check could "
            "never run")
    if not vfs.READ_REVALIDATABLE:
        raise ValueError(
            f"mount {prefix!r}: read: fresh needs a resource that stamps a "
            f"comparable content token on reads; {name} does not")
