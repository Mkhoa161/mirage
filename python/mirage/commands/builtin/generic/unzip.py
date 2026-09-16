import fnmatch
import io
import zipfile
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.generic.archive.extract import (ensure_dir,
                                                             extract_dest)
from mirage.commands.builtin.generic.archive.walk import StatFn
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

# Info-ZIP's wording and spacing, verbatim (two spaces after the colon).
CAUTION_PREFIX = "caution: filename not matched:  "


def _spec_index(name: bytes, members: tuple[bytes, ...]) -> int | None:
    for i, member in enumerate(members):
        if fnmatch.fnmatchcase(name, member):
            return i
    return None


def _select(
        infos: list[zipfile.ZipInfo],
        members: tuple[str, ...]) -> tuple[list[zipfile.ZipInfo], list[str]]:
    if not members:
        return infos, []
    # Info-ZIP matches filespecs against the encoded name, so `?` stands
    # for one byte, not one code point: `?.txt` misses `é.txt` and
    # `??.txt` hits it.
    encoded = tuple(member.encode() for member in members)
    # Info-ZIP walks the archive in order and charges each entry to the
    # first filespec that matches it, so a spec shadowed by an earlier
    # one reports "filename not matched" even when its file was printed.
    hit = [False] * len(members)
    selected: list[zipfile.ZipInfo] = []
    for info in infos:
        idx = _spec_index(info.filename.encode(), encoded)
        if idx is None:
            continue
        hit[idx] = True
        selected.append(info)
    unmatched = [m for m, h in zip(members, hit) if not h]
    return selected, unmatched


def _cautions(unmatched: list[str]) -> str:
    return "".join(CAUTION_PREFIX + member + "\n" for member in unmatched)


async def _make_dirs(dir_path: str, mkdir_fn: Callable[..., Awaitable[None]],
                     stat: StatFn | None, made: set[str]) -> None:
    """Create the chain for one entry, per door space.

    With a stat door the shared single-level walk runs (dispatch mkdir
    is single-level on most backends); without one the accessor's own
    mkdir handles the chain, which is the pre-workspace construction
    path where no dispatcher exists.

    Args:
        dir_path (str): the directory whose chain must exist.
        mkdir_fn (Callable): mkdir door.
        stat (StatFn | None): stat door in the same path space, if any.
        made (set[str]): levels already ensured this run.
    """
    if stat is None:
        await mkdir_fn(PathSpec.from_str_path(dir_path), parents=True)
        return
    await ensure_dir(dir_path, mkdir_fn, stat, made)


async def unzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
    members: tuple[str, ...] = (),
    o: bool = False,
    args_l: bool = False,
    d: str | PathSpec | None = None,
    q: bool = False,
    p: bool = False,
    t: bool = False,
    cwd: PathSpec | str = "/",
    relay: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("unzip: missing operand")
    archive_path = paths[0]
    if relay:
        # Relay doors address by full virtual path (flat_scopes'
        # convention), not by the mount-relative key the wrapper's
        # accessor stamped.
        archive_path = PathSpec.from_str_path(archive_path.virtual)
    data = await read_bytes(archive_path)
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        selected, unmatched = _select(zf.infolist(), members)
        if args_l:
            lines = ["  Length      Name", "---------  ----"]
            for info in selected:
                lines.append(f"{info.file_size:>9}  {info.filename}")
            listing = ("\n".join(lines) + "\n").encode()
            # GNU -l prints no caution lines and only exits 11 when the
            # member list matched nothing at all.
            if members and not selected:
                return listing, IOResult(exit_code=11)
            return listing, IOResult()
        if t:
            if members:
                bad = None
                for info in selected:
                    if info.is_dir():
                        continue
                    try:
                        zf.read(info)
                    except zipfile.BadZipFile:
                        bad = info.filename
                        break
            else:
                bad = zf.testzip()
            if bad is not None:
                return f"first bad file: {bad}\n".encode(), IOResult()
            if unmatched:
                # GNU -t reports unmatched members on stdout and counts
                # them as errors.
                msg = _cautions(unmatched) + (
                    f"At least one error was detected in "
                    f"{archive_path.virtual}.\n")
                return msg.encode(), IOResult(exit_code=11)
            msg = f"No errors detected in {archive_path.virtual}\n"
            return msg.encode(), IOResult()
        if p:
            chunks: list[bytes] = []
            for info in selected:
                if not info.is_dir():
                    # Read the selected ZipInfo, not its name: a name
                    # lookup resolves every duplicate to the last one.
                    chunks.append(zf.read(info))
            if unmatched:
                return b"".join(chunks), IOResult(
                    exit_code=11, stderr=_cautions(unmatched).encode())
            return b"".join(chunks), IOResult()
        mount_prefix = mount_prefix_of(
            archive_path.virtual, archive_path.resource_path) if isinstance(
                archive_path, PathSpec) else ""
        dest = extract_dest(d, cwd, relay)
        writes: dict[str, ByteSource] = {}
        made: set[str] = set()
        output_lines: list[str] = []
        for info in selected:
            entry_name = info.filename.lstrip("/")
            out_path = dest.rstrip("/") + "/" + entry_name.rstrip("/")
            report_path = out_path if relay else ((
                mount_prefix + out_path) if mount_prefix else out_path)
            if info.is_dir():
                # A directory entry is the only record an empty
                # directory leaves, so it has to be recreated even
                # though nothing is written inside it.
                await _make_dirs(out_path, mkdir_fn, stat, made)
                if not q:
                    output_lines.append(f"   creating: {report_path}/")
                continue
            content = zf.read(info)
            parent = out_path.rsplit("/", 1)[0] or "/"
            if parent != "/":
                await _make_dirs(parent, mkdir_fn, stat, made)
            await write_bytes(PathSpec.from_str_path(out_path), data=content)
            if not relay:
                # Relay writes land on whichever mount owns each path
                # and invalidate through the dispatcher; keying them
                # here would have the runner prefix them onto this
                # mount.
                writes[out_path] = content
            if not q:
                output_lines.append(f"  inflating: {report_path}")
    output = ("\n".join(output_lines) +
              "\n").encode() if output_lines else None
    if unmatched:
        return output, IOResult(exit_code=11,
                                stderr=_cautions(unmatched).encode(),
                                writes=writes)
    return output, IOResult(writes=writes)


__all__ = ["unzip"]


@dataclass(frozen=True, slots=True)
class UnzipFlags:
    overwrite: bool = False
    list_only: bool = False
    dest: "PathSpec | str | None" = None
    quiet: bool = False
    to_stdout: bool = False
    test_only: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> UnzipFlags:
    fl = FlagView(flags, spec=SPECS["unzip"])
    dest = fl.raw("d")
    return UnzipFlags(
        overwrite=fl.as_bool("o"),
        list_only=fl.as_bool("args_l"),
        dest=dest if isinstance(dest, (PathSpec, str)) else None,
        quiet=fl.as_bool("q"),
        to_stdout=fl.as_bool("p"),
        test_only=fl.as_bool("t"),
    )


async def unzip_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    mkdir_fn: Callable[..., Awaitable[None]],
    stat: StatFn | None = None,
    relay: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await unzip(paths,
                       read_bytes=read_bytes,
                       write_bytes=write_bytes,
                       mkdir_fn=mkdir_fn,
                       stat=stat,
                       members=tuple(texts),
                       o=parsed.overwrite,
                       args_l=parsed.list_only,
                       d=parsed.dest,
                       q=parsed.quiet,
                       p=parsed.to_stdout,
                       t=parsed.test_only,
                       cwd=opts.cwd,
                       relay=relay)
