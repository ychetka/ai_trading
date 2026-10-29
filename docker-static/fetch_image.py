#!/usr/bin/env python3
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
# For commercial use, please contact the author.

"""Fetch a Docker Hub image, merge layers into a flat rootfs with all
ownership rewritten to 0:0 (for single-uid rootless docker), and print
the flattened tar path + import args."""

import io
import json
import os
import shutil
import sys
import tarfile
import urllib.request

REPO = "n8nio/n8n"
TAG = "latest"
WORK = os.path.expanduser("~/docker-static/image-work")
ROOTFS = os.path.join(WORK, "rootfs")
OUT_TAR = os.path.join(WORK, "n8n-flat.tar")

MT_LIST = ",".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
    ]
)


def req(url, accept=None, token=None):
    r = urllib.request.Request(url)
    if accept:
        r.add_header("Accept", accept)
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    return urllib.request.urlopen(r, timeout=300)


def main():
    print("-> auth token", flush=True)
    tok = json.load(req(f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{REPO}:pull"))[
        "token"
    ]

    print("-> manifest", flush=True)
    mresp = req(f"https://registry-1.docker.io/v2/{REPO}/manifests/{TAG}", accept=MT_LIST, token=tok)
    manifest = json.load(mresp)
    mt = manifest.get("mediaType", "")
    if "index" in mt or "manifest.list" in mt:
        for m in manifest["manifests"]:
            p = m.get("platform", {})
            if p.get("architecture") == "amd64" and p.get("os") == "linux":
                manifest = json.load(
                    req(
                        f"https://registry-1.docker.io/v2/{REPO}/manifests/{m['digest']}",
                        accept="application/vnd.oci.image.manifest.v1+json,"
                        "application/vnd.docker.distribution.manifest.v2+json",
                        token=tok,
                    )
                )
                break
        else:
            sys.exit("no amd64 manifest found")

    cfg = json.load(req(f"https://registry-1.docker.io/v2/{REPO}/blobs/{manifest['config']['digest']}", token=tok))
    icfg = cfg.get("config", {})
    print(
        "image config:",
        json.dumps({k: icfg.get(k) for k in ("Env", "Entrypoint", "Cmd", "WorkingDir", "User")}, indent=2)[:3000],
        flush=True,
    )

    shutil.rmtree(ROOTFS, ignore_errors=True)
    os.makedirs(ROOTFS)

    for i, layer in enumerate(manifest["layers"]):
        dg = layer["digest"]
        print(f"-> layer {i + 1}/{len(manifest['layers'])} {dg[:20]}", flush=True)
        data = req(f"https://registry-1.docker.io/v2/{REPO}/blobs/{dg}", token=tok).read()
        if "zstd" in layer.get("mediaType", "") or data[:4] == b"\x28\xb5\x2f\xfd":
            import subprocess

            data = subprocess.run(["zstd", "-d", "-q", "-c"], input=data, capture_output=True, check=True).stdout
        apply_layer(io.BytesIO(data))

    print("-> repack flattened tar", flush=True)
    with tarfile.open(OUT_TAR, "w") as tar:

        def filt(ti):
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            if ti.isdev() or ti.isfifo():
                return None
            return ti

        tar.add(ROOTFS, arcname=".", filter=filt)

    print("DONE", flush=True)
    print("CONFIG_JSON=" + json.dumps({k: icfg.get(k) for k in ("Env", "Entrypoint", "Cmd", "WorkingDir")}))
    print("TAR=" + OUT_TAR)


def apply_layer(fobj):
    with tarfile.open(fileobj=fobj, mode="r:*") as tf:
        for m in tf:
            name = m.name.lstrip("./")
            if not name or name == ".":
                continue
            base = os.path.basename(name)
            dname = os.path.dirname(name)
            if base == ".wh..wh..opq":
                # opaque dir: clear existing contents
                d = os.path.join(ROOTFS, dname)
                if os.path.isdir(d):
                    for e in os.listdir(d):
                        p = os.path.join(d, e)
                        shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) and not os.path.islink(
                            p
                        ) else os.unlink(p)
                continue
            if base.startswith(".wh."):
                target = os.path.join(ROOTFS, dname, base[4:])
                if os.path.isdir(target) and not os.path.islink(target):
                    shutil.rmtree(target, ignore_errors=True)
                elif os.path.lexists(target):
                    os.unlink(target)
                continue
            dest = os.path.join(ROOTFS, name)
            if m.isdir():
                os.makedirs(dest, exist_ok=True)
                os.chmod(dest, m.mode & 0o7777)
            elif m.issym():
                if os.path.lexists(dest):
                    os.unlink(dest)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                os.symlink(m.linkname, dest)
            elif m.islnk():
                src = os.path.join(ROOTFS, m.linkname.lstrip("./"))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                if os.path.exists(src):
                    if os.path.lexists(dest):
                        os.unlink(dest)
                    os.link(src, dest)
            elif m.isreg():
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                src = tf.extractfile(m)
                with open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
                os.chmod(dest, m.mode & 0o7777)
            # skip devices/fifos (can't create unprivileged, not needed)


if __name__ == "__main__":
    os.makedirs(WORK, exist_ok=True)
    main()
