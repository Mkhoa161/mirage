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

from unittest.mock import patch

import pytest

from mirage.core.hf_hub.read import read_bytes, resolve_entry
from mirage.observe.context import RecordingScope
from tests.core.hf_hub.conftest import file_row, ps, seed


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes")
async def test_read_bytes_fetches_the_resolve_url(mock_bytes, loaded):
    mock_bytes.return_value = b"hello"
    assert await read_bytes(loaded, ps("a.txt")) == b"hello"
    url = mock_bytes.await_args.args[1]
    assert url == "https://huggingface.co/acme/widget/resolve/main/a.txt"
    assert mock_bytes.await_args.args[2] is None


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes")
async def test_read_bytes_passes_a_byte_window(mock_bytes, loaded):
    mock_bytes.return_value = b"he"
    await read_bytes(loaded, ps("a.txt"), offset=0, size=2)
    window = mock_bytes.await_args.args[2]
    assert (window.offset, window.size) == (0, 2)


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes")
async def test_read_bytes_prefixes_the_repo_path(mock_bytes, prefixed):
    """A prefix normalized with a trailing slash must not double up."""
    from tests.core.hf_hub.conftest import file_row, seed
    seed(prefixed, file_row("a.txt"))
    mock_bytes.return_value = b""
    await read_bytes(prefixed, ps("a.txt"))
    assert mock_bytes.await_args.args[1].endswith(
        "/resolve/main/sub/dir/a.txt")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes")
async def test_read_of_a_missing_path_never_reaches_the_network(
        mock_bytes, loaded):
    with pytest.raises(FileNotFoundError):
        await read_bytes(loaded, ps("nope"))
    mock_bytes.assert_not_awaited()


@pytest.mark.asyncio
async def test_read_of_a_directory_is_eisdir(loaded):
    with pytest.raises(IsADirectoryError):
        await read_bytes(loaded, ps("d"))


@pytest.mark.asyncio
async def test_read_of_the_mount_root_is_eisdir(loaded):
    with pytest.raises(IsADirectoryError):
        await read_bytes(loaded, ps(""))


@pytest.mark.asyncio
async def test_resolve_entry_returns_the_row(loaded):
    from mirage.cache.index import NULL_INDEX
    entry = await resolve_entry(loaded, ps("a.txt"), NULL_INDEX)
    assert entry.size == 7


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes")
async def test_read_records_the_virtual_path(mock_bytes, accessor):
    # read recorded mount_path ("/m/k.txt"). The repo holds a folder
    # named like the mount, so that differs from the virtual path; no
    # recorder prefix is pushed.
    seed(accessor, file_row("m/k.txt", 5))
    mock_bytes.return_value = b"hello"
    scope = RecordingScope()
    try:
        data = await read_bytes(accessor, ps("m/k.txt", "/m"))
    finally:
        scope.close()
    assert data == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]
