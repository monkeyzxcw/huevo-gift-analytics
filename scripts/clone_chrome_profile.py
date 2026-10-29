"""Copy an already signed-in Chrome profile into the collector's local-only profile dir.

Why a copy: Chrome (136+) refuses automation on its default data directory, and two
Chrome instances cannot share one directory. The copy stays on this PC in
.local-huevo-chrome-profile (gitignored). Cookie values are never read or printed:
files are copied as opaque bytes.

Usage (close ALL Chrome windows first):
    python scripts/clone_chrome_profile.py --list
    python scripts/clone_chrome_profile.py --profile "Profile 1"
Then set HUEVO_CHROME_PROFILE to the same name for the collector.
"""
import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / ".local-huevo-chrome-profile"
SKIP = shutil.ignore_patterns(
    "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache",
    "Service Worker", "Crashpad", "BrowserMetrics*", "Singleton*", "lockfile", "*.tmp")


def default_user_data():
    base = os.getenv("LOCALAPPDATA")
    return Path(base) / "Google" / "Chrome" / "User Data" if base else None


def profiles(src):
    return sorted(p.name for p in src.iterdir()
                  if p.is_dir() and (p.name == "Default" or p.name.startswith("Profile "))
                  and (p / "Preferences").exists())


def chrome_running():
    if os.name != "nt":
        return False
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq chrome.exe"], capture_output=True, text=True).stdout
    return "chrome.exe" in out.lower()


def clone(src, profile, dest, force=False):
    if not (src / "Local State").exists() or not (src / profile).is_dir():
        raise SystemExit(f"Профиль {profile!r} не найден в {src}.")
    if dest.exists() and any(dest.iterdir()):
        if not force:
            raise SystemExit(f"{dest.name} уже существует. Запустите с --force: старая папка будет переименована в резервную, не удалена.")
        backup = dest.with_name(dest.name + ".bak-" + time.strftime("%Y%m%d-%H%M%S"))
        dest.rename(backup)
        print(f"Старый профиль сохранён как {backup.name}")
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src / "Local State", dest / "Local State")   # holds the key that decrypts cookies
    shutil.copytree(src / profile, dest / profile, ignore=SKIP)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source-dir", type=Path, default=default_user_data(), help="Chrome 'User Data' directory")
    ap.add_argument("--profile", default="Default")
    ap.add_argument("--dest", type=Path, default=DEST)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    if not args.source_dir or not args.source_dir.is_dir():
        raise SystemExit("Папка Chrome 'User Data' не найдена. Укажите --source-dir.")
    if args.list:
        print("\n".join(profiles(args.source_dir)) or "Профили не найдены")
        return 0
    if chrome_running():
        raise SystemExit("Chrome запущен. Закройте ВСЕ окна Chrome (и в трее) и повторите.")
    clone(args.source_dir, args.profile, args.dest, args.force)
    print(f"Готово. Дальше: set HUEVO_CHROME_PROFILE={args.profile}  и запустите сборщик.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
