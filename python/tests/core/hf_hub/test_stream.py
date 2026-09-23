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

from mirage.core.hf_hub.stream import range_read, read_stream
from mirage.observe.context import RecordingScope
from tests.core.hf_hub.conftest import file_row, ps, seed


async def _chunks(*payload):
    for item in payload:
        yield item


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.stream.hub_stream")
async def test_read_stream_yields_every_chunk(mock_stream, loaded):
    mock_stream.return_value = _chunks(b"ab", b"cd")
    got = [c async for c in read_stream(loaded, ps("a.txt"))]
    assert got == [b"ab", b"cd"]
    assert mock_stream.call_args.args[1].endswith("/resolve/main/a.txt")


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.stream.hub_stream")
async def test_read_stream_of_a_directory_is_eisdir(mock_stream, loaded):
    with pytest.raises(IsADirectoryError):
        [c async for c in read_stream(loaded, ps("d"))]
    mock_stream.assert_not_called()


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.read.hub_bytes")
async def test_range_read_is_end_exclusive(mock_bytes, loaded):
    mock_bytes.return_value = b"abc"
    await range_read(loaded, ps("a.txt"), 2, 5)
    window = mock_bytes.await_args.args[2]
    assert (window.offset, window.size) == (2, 3)


@pytest.mark.asyncio
@patch("mirage.core.hf_hub.stream.hub_stream")
async def test_stream_records_the_virtual_path(mock_stream, accessor):
    # A repo folder named like its mount keeps /m/k.txt off the virtual path.
    seed(accessor, file_row("m/k.txt", 4))
    mock_stream.return_value = _chunks(b"ab", b"cd")
    scope = RecordingScope()
    try:
        got = [c async for c in read_stream(accessor, ps("m/k.txt", "/m"))]
    finally:
        scope.close()
    assert got == [b"ab", b"cd"]
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]
