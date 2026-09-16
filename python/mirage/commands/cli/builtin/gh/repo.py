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

from typing import Any

from mirage.commands.cli.builtin.gh.accessor import (camel, gh_repo,
                                                     list_limit, text_out,
                                                     typed_out)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import (create_repo, fork_repo, list_repos, login,
                                     read_readme, rename_repo, view_repo)
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

REPO_FIELDS = ("createdAt", "defaultBranchRef", "description", "isFork",
               "isPrivate", "name", "nameWithOwner", "owner", "pushedAt",
               "updatedAt", "url", "visibility")


def _repo(value: Any) -> dict[str, Any]:
    row = camel(value)
    result = row if isinstance(row, dict) else {}
    if "fullName" in result:
        result["nameWithOwner"] = result.pop("fullName")
    if "defaultBranch" in result:
        result["defaultBranchRef"] = {"name": result.pop("defaultBranch")}
    if "private" in result:
        result["isPrivate"] = result.pop("private")
    if "fork" in result:
        result["isFork"] = result.pop("fork")
    owner = result.get("owner")
    if isinstance(owner, dict) and "login" not in owner and "name" in owner:
        owner["login"] = owner["name"]
    return result


def summary(repo: JsonValue, readme: str | None) -> str:
    """gh's own text view of a repository.

    Two tab-separated header lines and then the README verbatim, with the
    `--` separator omitted entirely when there is no README. Probed
    against gh 2.85, whose description line is present and empty for a
    repository that has none.

    Args:
        repo (JsonValue): the REST repository object.
        readme (str | None): the decoded README, None when absent.

    Returns:
        str: what gh prints.
    """
    fields = repo if isinstance(repo, dict) else {}
    name = fields.get("full_name")
    description = fields.get("description")
    head = (f"name:\t{name if isinstance(name, str) else ''}\n"
            f"description:\t"
            f"{description if isinstance(description, str) else ''}\n")
    if readme is None:
        return head
    return f"{head}--\n{readme}"


async def view(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    operand = inv.texts[0] if inv.texts else None
    ref = gh_repo(inv.config, operand or fl.as_str("repo"))
    repo = await view_repo(inv.config, ref)
    row = _repo(repo)
    human = ("" if fl.as_str("json") is not None else summary(
        repo, await read_readme(inv.config, ref)))
    return await typed_out(row, fl, human, REPO_FIELDS)


async def list_cmd(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    owner = inv.texts[0] if inv.texts else None
    rows = [
        _repo(value)
        for value in await list_repos(inv.config, owner, list_limit(fl, 30))
    ]
    human = "".join(f'{row.get("nameWithOwner", "")}\t'
                    f'{row.get("description", "")}\t'
                    f'{row.get("visibility", "")}\t'
                    f'{row.get("updatedAt", "")}\n' for row in rows)
    return await typed_out(rows, fl, human, REPO_FIELDS)


async def create_cmd(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    spec = inv.texts[0] if inv.texts else ""
    if not spec:
        raise ValueError(
            "a repository name is required in noninteractive mode")
    parts = spec.split("/")
    if len(parts) > 2 or any(not part for part in parts):
        raise ValueError(f'invalid repository name: "{spec}"')
    owner = parts[0] if len(parts) == 2 else None
    name = parts[-1]
    if fl.as_bool("public") and fl.as_bool("private"):
        raise ValueError("--public and --private are mutually exclusive")
    body: dict[str, JsonValue] = {
        "name": name,
        "private": fl.as_bool("private"),
        "auto_init": fl.as_bool("add_readme"),
    }
    for flag, key in (("description", "description"), ("homepage",
                                                       "homepage")):
        value = fl.as_str(flag)
        if value is not None:
            body[key] = value
    created = _repo(await create_repo(inv.config, owner, body))
    return text_out(f'{created.get("url", "")}\n')


async def fork(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    operand = inv.texts[0] if inv.texts else None
    source = gh_repo(inv.config, operand)
    name = fl.as_str("fork_name")
    forked = await fork_repo(inv.config, source, name)
    landed = forked.get("full_name") if isinstance(forked, dict) else None
    full = landed if isinstance(
        landed, str) else (f"{await login(inv.config)}/{name or source.repo}")
    return text_out(f"✓ Created fork {full}\n")


async def rename(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    # gh takes the *new name* as the operand and the repository to rename as
    # -R, which is the reverse of what the shape of the line suggests.
    target = gh_repo(inv.config, fl.as_str("repo"))
    name = inv.texts[0] if inv.texts else ""
    if not name:
        raise ValueError("a new repository name is required")
    renamed = await rename_repo(inv.config, target, name)
    landed = renamed.get("full_name") if isinstance(renamed, dict) else None
    full = landed if isinstance(landed, str) else name
    return text_out(f"✓ Renamed repository {full}\n")
