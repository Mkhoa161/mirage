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
from typing import Any

from mirage.commands.cli.builtin.gh.accessor import (camel, list_limit,
                                                     read_cli_file, repo_for,
                                                     text_out, typed_out)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.actions import (dispatch_workflow, get_run,
                                        get_workflow, list_runs,
                                        list_workflows, rerun, rerun_job)
from mirage.core.github.config import GhConfig
from mirage.core.github.repo import view_repo
from mirage.io.stream import materialize
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

RUN_FIELDS = ("attempt", "conclusion", "createdAt", "databaseId",
              "displayTitle", "event", "headBranch", "headSha", "name",
              "number", "startedAt", "status", "updatedAt", "url",
              "workflowDatabaseId", "workflowName")
WORKFLOW_FIELDS = ("id", "name", "path", "state")


def _run(value: JsonValue) -> dict[str, Any]:
    row = camel(value)
    result = row if isinstance(row, dict) else {}
    if "id" in result:
        result["databaseId"] = result.pop("id")
    if "htmlUrl" in result:
        result["url"] = result.pop("htmlUrl")
    if "runAttempt" in result:
        result["attempt"] = result.pop("runAttempt")
    if "runNumber" in result:
        result["number"] = result.pop("runNumber")
    if "workflowId" in result:
        result["workflowDatabaseId"] = result.pop("workflowId")
    result.setdefault("workflowName", result.get("name", ""))
    result.setdefault("startedAt", result.get("runStartedAt"))
    return result


def _workflow(value: JsonValue) -> dict[str, Any]:
    row = camel(value)
    return row if isinstance(row, dict) else {}


async def run_list_cmd(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    params: dict[str, str] = {}
    for flag, key in (("branch", "branch"), ("commit", "head_sha"),
                      ("event", "event"), ("status", "status"),
                      ("user", "actor"), ("created", "created")):
        value = fl.as_str(flag)
        if value:
            params[key] = value
    rows = [
        _run(value)
        for value in await list_runs(inv.config, repo_for(inv, fl), params,
                                     list_limit(fl, 20), fl.as_str("workflow"))
    ]
    human = "".join(f'{row.get("status", "")}\t'
                    f'{row.get("conclusion", "")}\t'
                    f'{row.get("displayTitle", "")}\t'
                    f'{row.get("workflowName", "")}\t'
                    f'{row.get("headBranch", "")}\t'
                    f'{row.get("event", "")}\t{row.get("databaseId", "")}\n'
                    for row in rows)
    return await typed_out(rows, fl, human, RUN_FIELDS)


async def run_view_cmd(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    raw = inv.texts[0] if inv.texts else ""
    if not raw.isdigit():
        raise ValueError("a run ID is required in noninteractive mode")
    row = _run(await get_run(inv.config, repo_for(inv, fl), int(raw)))
    human = (f'title:\t{row.get("displayTitle", "")}\n'
             f'workflow:\t{row.get("workflowName", "")}\n'
             f'status:\t{row.get("status", "")}\n'
             f'conclusion:\t{row.get("conclusion", "")}\n'
             f'branch:\t{row.get("headBranch", "")}\n'
             f'event:\t{row.get("event", "")}\n')
    out, io = await typed_out(row, fl, human, RUN_FIELDS)
    if fl.as_bool("exit_status") and row.get("conclusion") not in (None, "",
                                                                   "success"):
        io.exit_code = 1
    return out, io


async def run_rerun_cmd(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    raw = inv.texts[0] if inv.texts else ""
    if not raw.isdigit():
        raise ValueError("a run ID is required in noninteractive mode")
    ref = repo_for(inv, fl)
    job = fl.as_str("job")
    if job:
        if not job.isdigit():
            raise ValueError("--job expects a numeric job ID")
        await rerun_job(inv.config, ref, int(job), fl.as_bool("debug"))
    else:
        suffix = "rerun-failed-jobs" if fl.as_bool("failed") else "rerun"
        body: JsonValue = ({
            "enable_debug_logging": True
        } if fl.as_bool("debug") else None)
        await rerun(inv.config, ref, int(raw), suffix, body)
    return text_out("")


async def workflow_list_cmd(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    include = (None if fl.as_bool("all") else
               lambda row: row.get("state") == "active")
    rows = [
        _workflow(value) for value in await list_workflows(
            inv.config, repo_for(inv, fl), list_limit(fl, 50), include=include)
    ]
    human = "".join(f'{row.get("name", "")}\t{row.get("state", "")}\t'
                    f'{row.get("id", "")}\n' for row in rows)
    return await typed_out(rows, fl, human, WORKFLOW_FIELDS)


async def workflow_view_cmd(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    workflow = inv.texts[0] if inv.texts else ""
    if not workflow:
        raise ValueError("a workflow ID, name, or filename is required")
    row = _workflow(await get_workflow(inv.config, repo_for(inv, fl),
                                       workflow))
    human = (f'{row.get("name", "")} - {row.get("state", "")}\n'
             f'ID: {row.get("id", "")}\nFile: {row.get("path", "")}\n')
    return text_out(human)


async def _workflow_inputs(inv: CLIInvocation[GhConfig],
                           fl: FlagView) -> dict[str, JsonValue]:
    if fl.as_bool("json"):
        if inv.stdin is None:
            raise ValueError("--json needs standard input")
        try:
            value = json.loads((await materialize(inv.stdin)).decode())
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"invalid JSON from standard input: {exc.msg}") from None
        if not isinstance(value, dict):
            raise ValueError("workflow inputs must be a JSON object")
        return value
    inputs: dict[str, JsonValue] = {}
    for pair in fl.as_list("raw_field"):
        key, sep, value = pair.partition("=")
        if not sep:
            raise ValueError(f'expected "key=value", got "{pair}"')
        inputs[key] = value
    for pair in fl.as_list("field"):
        key, sep, value = pair.partition("=")
        if not sep:
            raise ValueError(f'expected "key=value", got "{pair}"')
        inputs[key] = ((await read_cli_file(inv, value[1:],
                                            "--field")).decode()
                       if value.startswith("@") else value)
    return inputs


async def workflow_run_cmd(
        inv: CLIInvocation[GhConfig]) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    workflow = inv.texts[0] if inv.texts else ""
    if not workflow:
        raise ValueError("a workflow ID, name, or filename is required")
    ref = repo_for(inv, fl)
    branch = fl.as_str("ref") or inv.config.branch
    if not branch:
        repo = await view_repo(inv.config, ref)
        candidate = repo.get("default_branch") if isinstance(repo,
                                                             dict) else None
        branch = candidate if isinstance(candidate, str) else None
    if not isinstance(branch, str) or not branch:
        raise ValueError("a workflow ref is required")
    body: dict[str, JsonValue] = {
        "ref": branch,
        "inputs": await _workflow_inputs(inv, fl)
    }
    await dispatch_workflow(inv.config, ref, workflow, body)
    return text_out("")
