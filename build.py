"""
Run this once before pyinstaller: it copies the ffmpeg binary that
imageio-ffmpeg already downloaded into ./bin, so PyInstaller can bundle it
as a plain data file (see gif_forge.spec). Without this step the app would
still run from source, but the frozen exe wouldn't carry its own ffmpeg.
"""
import os
import shutil
import sys

import imageio_ffmpeg


def main():
    src = imageio_ffmpeg.get_ffmpeg_exe()
    os.makedirs("bin", exist_ok=True)
    dst_name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    dst = os.path.join("bin", dst_name)
    shutil.copy2(src, dst)
    if sys.platform != "win32":
        os.chmod(dst, 0o755)
    print(f"vendored ffmpeg:\n  {src}\n  -> {dst}")


if __name__ == "__main__":
    main()
