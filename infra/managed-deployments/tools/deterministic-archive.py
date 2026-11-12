#!/usr/bin/env python3
"""Portable, byte-reproducible installer archive; no host metadata or timestamps."""
import gzip
import pathlib
import sys
import tarfile


def archive(source, destination):
    root = pathlib.Path(source)
    with open(destination, "wb") as output:
        with gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as bundle:
                for path in sorted(root.rglob("*")):
                    if path.is_symlink():
                        raise ValueError(f"Refusing symlink: {path}")
                    if path.is_dir():
                        continue
                    if not path.is_file():
                        raise ValueError(f"Refusing nonregular file: {path}")
                    info = tarfile.TarInfo(path.relative_to(root).as_posix())
                    info.size = path.stat().st_size
                    info.mode = 0o644
                    with path.open("rb") as content:
                        bundle.addfile(info, content)


if __name__ == "__main__":
    archive(*sys.argv[1:])
