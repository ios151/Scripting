# 发布构建：把仓库根下的每个脚本目录打成 dist/<名字>.zip。
#
#   python build-release.py
#
# 关键约束：zip 的**根目录**必须直接是 script.json / index.tsx，不能多一层脚本目录名。
# 应用导入时按 zip 根找 script.json，多包一层就认不出来。打完会断言一次。
#
# zip 的文件名只影响导入链接长什么样，脚本真正的名字取自 zip 里的 script.json，
# 所以这里用 ASCII 别名，免得 raw 链接里塞满 %E4%BD 这种东西。
#
# 另外把 skills/ 下每个带 SKILL.md 的目录（给 Scripting 里的 AI 用的技能，不是脚本）打成
# dist/<别名>.zip。技能的 zip 和脚本的相反：根上保留一层 <技能名>/ 目录，SKILL.md 在它里面——
# 这是用户手机上导入成功过的布局。时间戳固定，内容没变时每次打出来都逐字节相同。

import io
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")

# 脚本目录名 → zip 文件名（不含扩展名）
ALIASES = {
    "WLOC 虚拟定位": "WLOC",
    "设备工具箱": "DeviceToolbox",
    "快捷指令签名": "ShortcutSigner",
}

# 技能目录名 → zip 文件名（不含扩展名）
SKILL_ALIASES = {
    "shortcut-signer": "ShortcutSignerSkill",
}
SKILLS = os.path.join(HERE, "skills")
# zip 里每个文件的时间戳（zip 不接受 1980 年以前的日期）
SKILL_ZIP_TIME = (2026, 1, 1, 0, 0, 0)

SKIP = {"dist", "node_modules", "__pycache__"}
REQUIRED = ("script.json", "index.tsx")


def script_dirs():
    for name in sorted(os.listdir(HERE)):
        if name.startswith(".") or name in SKIP:
            continue
        path = os.path.join(HERE, name)
        if os.path.isfile(os.path.join(path, "script.json")):
            yield name, path


def build(name: str, src: str) -> str:
    out = os.path.join(DIST, ALIASES.get(name, name) + ".zip")
    os.makedirs(DIST, exist_ok=True)
    if os.path.exists(out):
        os.remove(out)

    entries = []
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith(".")]
            for f in sorted(files):
                if f.startswith("."):
                    continue
                full = os.path.join(root, f)
                rel = os.path.relpath(full, src).replace(os.sep, "/")  # 相对脚本目录 = zip 根
                z.write(full, rel)
                entries.append(rel)

    missing = [r for r in REQUIRED if r not in entries]
    if missing:
        raise SystemExit(f"{name}: zip 根缺少 {missing}，实际: {entries[:10]}")

    meta = json.load(io.open(os.path.join(src, "script.json"), encoding="utf-8"))
    kb = os.path.getsize(out) // 1024
    print(f"{os.path.basename(out):<24} {len(entries):>3} 个文件  {kb:>4} KB  v{meta.get('version')}")
    return out


def skill_dirs():
    if not os.path.isdir(SKILLS):
        return
    for name in sorted(os.listdir(SKILLS)):
        path = os.path.join(SKILLS, name)
        if os.path.isfile(os.path.join(path, "SKILL.md")):
            yield name, path


def build_skill(name: str, src: str) -> str:
    out = os.path.join(DIST, SKILL_ALIASES.get(name, name) + ".zip")
    os.makedirs(DIST, exist_ok=True)
    if os.path.exists(out):
        os.remove(out)

    entries = []
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(src):
            dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith("."))
            for f in sorted(files):
                if f.startswith("."):
                    continue
                full = os.path.join(root, f)
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                info = zipfile.ZipInfo(f"{name}/{rel}", date_time=SKILL_ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                with open(full, "rb") as fh:
                    z.writestr(info, fh.read(), compresslevel=9)
                entries.append(rel)

    if "SKILL.md" not in entries:
        raise SystemExit(f"{name}: 技能目录里没有 SKILL.md，实际: {entries[:10]}")

    kb = os.path.getsize(out) // 1024
    print(f"{os.path.basename(out):<24} {len(entries):>3} 个文件  {kb:>4} KB  技能 {name}")
    return out


def main():
    built = [build(name, src) for name, src in script_dirs()]
    if not built:
        raise SystemExit("仓库根下没有找到任何脚本目录（判定依据：目录里有 script.json）")
    for name, src in skill_dirs():
        build_skill(name, src)


if __name__ == "__main__":
    main()
