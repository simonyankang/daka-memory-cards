#!/usr/bin/env python3
# 生成真实的 .apkg (ZIP + SQLite) 测试样本，仅用 Python 标准库。
# 用途：给纯前端 apkg.js 解析器做端到端自检，不依赖网络或第三方库。
# 造出的 db 结构对齐 Anki collection.anki2 的关键表/字段：
#   col(id, models) / notes(id, guid, mid, flds, tags) / cards(id, nid, ord)
# 边界覆盖：0x1F 多字段、HTML、img/sound 媒体引用、Cloze、空 front、重复 guid。

import os
import sqlite3
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixture.apkg")
OUT_ANKI21 = os.path.join(HERE, "fixture_anki21.apkg")
OUT_ANKI21B = os.path.join(HERE, "fixture_anki21b.apkg")
OUT_BAD = os.path.join(HERE, "fixture_bad.apkg")
OUT_COLPKG = os.path.join(HERE, "fixture.colpkg")

SEP = "\x1f"

# (guid, front, back, tags)
NOTES = [
    ("g1", "中国的首都是哪座城市？", "北京", "地理 常识"),
    ("g2", "1 + 1 = ?", "2", "数学"),
    ("g3", "<b>水的化学式</b>是？", "H<sub>2</sub>O", "化学 科学"),
    ("g4", '看图：这是什么动物？ <img src="0.jpg">', "猫", "生物 带图"),
    ("g5", "听发音并拼写 [sound:_1.mp3]", "hello", "英语 带音频"),
    ("g6", "Cloze：{{c1::北京}}是中国的首都", "", "语文 cloze"),
    ("g7", "  前后有空格的问题  ", "  答案  ", "  空白 "),
    ("g8", "含,逗号与\"引号\"以及\n换行的字段", "多行\n答案", "特殊"),
    ("g9", "重复的guid会怎样", "应被去重", "重复"),
    ("g9", "重复的guid会怎样(第二条)", "应被跳过", "重复"),
    ("", "没有guid的卡片", "按正文哈希去重", "无guid"),
    ("g11", "", "只有背面没有正面", "边界"),
    ("g12", "正反面都有的普通卡", "正常", "常规"),
    ("", "", "", "正反面全空应跳过"),
]


def build_db(path, model_json):
    con = sqlite3.connect(path)
    cur = con.cursor()
    cur.execute("CREATE TABLE col (id integer primary key, models text)")
    cur.execute("INSERT INTO col (id, models) VALUES (?, ?)", (1, model_json))
    cur.execute(
        "CREATE TABLE notes (id integer primary key, guid text, mid integer, flds text, tags text)"
    )
    for i, (guid, front, back, tags) in enumerate(NOTES, start=1000):
        flds = front + SEP + back
        tag_str = " " + tags.strip() + " " if tags.strip() else ""
        cur.execute(
            "INSERT INTO notes (id, guid, mid, flds, tags) VALUES (?, ?, ?, ?, ?)",
            (i, guid, 1600000000000, flds, tag_str),
        )
    cur.execute("CREATE TABLE cards (id integer primary key, nid integer, ord integer)")
    for i in range(len(NOTES)):
        cur.execute(
            "INSERT INTO cards (id, nid, ord) VALUES (?, ?, ?)",
            (2000 + i, 1000 + i, 0),
        )
    con.commit()
    con.close()


MODEL_BASIC = '{"1600000000000": {"name": "Basic", "flds": [{"name": "Front"}, {"name": "Back"}]}}'


def make_zip(db_path, out_path, db_entry):
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(db_path, db_entry)
        z.writestr("media", '{"0": "0.jpg", "1": "_1.mp3"}')
        z.writestr("0", b"\xff\xd8\xff\xe0FAKEJPEGDATA\xff\xd9")
        z.writestr("1", b"ID3FAKEAUDIO")


def main():
    tmp = tempfile.mkdtemp()
    db = os.path.join(tmp, "collection.anki2")

    # 1) 老版：collection.anki2，直接可用
    build_db(db, MODEL_BASIC)
    make_zip(db, OUT, "collection.anki2")

    # 1b) .colpkg 整库包：内部数据库条目同名，仅扩展名不同
    make_zip(db, OUT_COLPKG, "collection.anki2")

    # 2) 新版命名：collection.anki21（同样未压缩 SQLite，字段名一致）
    make_zip(db, OUT_ANKI21, "collection.anki21")

    # 3) anki21b：内容为 Zstd 压缩的 SQLite。标准库无 zstd，这里放入
    #    一个带 Zstd 魔数 (0x28B52FFD) 的假字节，仅用于验证解析器的
    #    「识别并友好降级」分支，不代表真实可解压数据。
    with zipfile.ZipFile(OUT_ANKI21B, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("collection.anki21b", b"\x28\xb5\x2f\xfd" + b"\x00" * 64)
        z.writestr("media", "{}")

    # 4) 坏包：ZIP 里没有任何 SQLite 数据库条目
    with zipfile.ZipFile(OUT_BAD, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("readme.txt", "there is no database here")

    print("generated:")
    for p in (OUT, OUT_COLPKG, OUT_ANKI21, OUT_ANKI21B, OUT_BAD):
        print("  %s (%d bytes)" % (os.path.basename(p), os.path.getsize(p)))


if __name__ == "__main__":
    main()
