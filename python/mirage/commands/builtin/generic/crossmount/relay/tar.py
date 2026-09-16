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

from mirage.commands.builtin.generic.archive.types import Walked
from mirage.commands.builtin.generic.crossmount.types import CrossResult
from mirage.commands.builtin.generic.crossmount.utils import \
    transfer_primitives
from mirage.commands.builtin.generic.tar.tar import tar
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


async def _no_walk(path: PathSpec, find_type: str) -> Walked:
    raise ValueError("tar: create never runs on the relay tier")


async def _no_dir_probe(path: PathSpec) -> bool:
    raise ValueError("tar: create never runs on the relay tier")


async def run_tar(scopes: list[PathSpec], text_args: list[str],
                  flag_kwargs: dict[str, FlagValue],
                  dispatch: DispatchFn) -> CrossResult:
    """Run a -t/-x tar whose archive and -C destination span mounts.

    Pure wiring: the shared generic runs on dispatch-relayed doors, so
    the archive is read from its mount and every extracted path lands
    on whichever mount owns it. Create mode never reaches here: the
    executor keeps a create-mode span on the plain refusal, because its
    planner walks one backend's tree and relay doors would cross nested
    mount boundaries the planner is required to refuse.

    Args:
        scopes (list[PathSpec]): Path operands in command-line order.
        text_args (list[str]): The -t/-x member selectors, as typed.
        flag_kwargs (dict): Flags parsed against the shared tar spec,
            with path-valued flags as resolved virtual strings.
        dispatch (DispatchFn): Workspace operation dispatcher.
    """
    fl = FlagView(flag_kwargs, spec=SPECS["tar"])
    prim = transfer_primitives(dispatch)
    archive = fl.as_str("f")
    directories = [str(part) for part in fl.as_list("C")]
    return await tar(
        [],
        read_bytes=prim["read_bytes"],
        write_bytes=prim["write"],
        mkdir_fn=prim["mkdir"],
        stat=prim["stat"],
        walk=_no_walk,
        is_dir=_no_dir_probe,
        selectors=list(text_args),
        x=fl.as_bool("x"),
        t=fl.as_bool("t"),
        z=fl.as_bool("z"),
        j=fl.as_bool("j"),
        J=fl.as_bool("J"),
        v=fl.as_bool("v"),
        to_stdout=fl.as_bool("to_stdout"),
        f=PathSpec.from_str_path(archive) if archive else None,
        C=[PathSpec.from_str_path(d) for d in directories] or None,
        strip_components=fl.as_str("strip_components"),
        relay=True,
    )
