# S3–S5 · 建项目、门禁、渲染归档

## 路径探测（不写死绝对路径）

```bash
command -v node python3 ffmpeg ffprobe
find ~/.workbuddy/skills -maxdepth 3 -name render.mjs -path "*bb-video*"
find ~/.workbuddy/skills -maxdepth 3 -name tts.py    -path "*bb-video*"
```

或复制 `scripts/paths.env.example` 为 `scripts/paths.env` 填一次：

```bash
NODE_BIN=...
PY_BIN=...
BB_VIDEO=.../bb-video
QA=$SKILL/scripts/qa.mjs
OUTPUT_ROOT="$HOME/Documents/Creative Materials/Output/AI视频"
```

下文用 `$NODE` / `$PY` / `$RENDER` / `$TTS` / `$QA` 代表这些值。**所有项目路径都用绝对路径传给渲染器。**

## S3 建项目

```bash
PROJ="<项目绝对路径>"
cp -R "<一个已能跑的项目>/lib" "$PROJ/"
cp -R "<一个已能跑的项目>/assets" "$PROJ/"
cp    "<一个已能跑的项目>/characters.js" "$PROJ/"
cp    "$SKILL/templates/skeleton.html" "$PROJ/index.html"
cp    "$SKILL/templates/script.json"   "$PROJ/script.json"
cp    "$SKILL/templates/brief.md"      "$PROJ/brief.md"
```

然后改 `script.json` 的 lines、按骨架的 `cols/card/cardLines/banner/rowLabels` 写画面、更新 `brief.md` 的屏幕文案清单。

**禁止手写坐标偏移**。骨架的 `cols(n)` 会返回每列 `{x, cx, w}`，`card/cardLines` 自动把文字放在框中心并均分行距 —— 这是从源头消除「字没居中 / 压框线」的关键。已验证的安全栅格：

| 列数 | 列宽 | x 起点 |
|---|---|---|
| 2 | 470 | 60 / 550 |
| 3 | 290 | 60 / 395 / 730 |
| 4 | 225 | 60 / 305 / 550 / 795 |
| 5 | 176 | 60 / 256 / 452 / 648 / 844 |

整宽框 `x=60, w=960`。任何 `x + w ≤ 1020`。竖屏字幕在约 78% 高度，内容不进 y>1500。

## S4 门禁（顺序固定）

```bash
$PY   $TTS "$PROJ"                                              # 1 配音 + timeline
$NODE $QA "$PROJ" --aspect 9:16                                  # 2 必须 0 error
$NODE $RENDER "$PROJ" --check --aspect 9:16                      # 3 必须 0 error
$NODE $RENDER "$PROJ" --stills <每幕一个时间点> --aspect 9:16    # 4 抽帧目视
```

`qa.mjs` 的报错精确到 `index.html:行号`：

| 码 | 修法 |
|---|---|
| E1 越界 | 收进安全区 |
| E2 压框线 / 溢出 | 用 `cardLines()` 自动排，或缩小字号 / 加大框高 |
| E3 未居中 | 用 `col.cx`，别自己算 `x + w/2` |
| E4 同列压叠 | 加大行距 / 减小字号 |
| E5 锚点错句 | 换成该句真实出现的词；改了旁白要同步改锚点 |
| E6 文案未登记 | 补进 `brief.md` 的 On-screen text |
| W2 锚点节奏 | 一幕里过半锚点挤在句尾 → 换成句子前半段的对应词 |

参数：`--aspect 9:16`（默认）/ `16:9`、`--json`、`--no-brief`。

**抽帧目视查工具查不到的事**：字形观感、逐词点亮顺序、画面是否长时间只有标题、封面便签是否有字。每幕至少一帧；发现某幕前 2/3 只有标题，把主视觉锚点前移后重跑门禁。

## S5 渲染与归档

```bash
# 必须后台跑：前台长渲染在会话结束时会收到 SIGKILL(137)
$NODE $RENDER "$PROJ" --aspect 9:16 --workers 1 --blur 1 > "$PROJ/render-final.log" 2>&1

# 成片出来后
mkdir -p "$OUTPUT_ROOT/<系列>/<编号. 作品名>"
cp "$PROJ/out/video-9x16.mp4"        "$DST/<作品名>·成片.mp4"
cp "$PROJ/out/captions-9x16.srt"     "$DST/<作品名>·字幕.srt"
ffmpeg -y -ss 1.0 -i "$PROJ/out/video-9x16.mp4" -frames:v 1 -update 1 "$DST/<作品名>·封面.png"
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 "$DST/<作品名>·成片.mp4"
```

**封面一定自己从成片 t=1.0s 抽**：引擎自动导出的 `cover-9x16.png` 可能抽在文字逐字揭示之前，得到只有边框没有标题的空封面。

## 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 前台渲染退出码 137 | 会话结束把 ffmpeg 杀了 | 后台跑，等完成再继续 |
| `Cannot find module render.mjs` | 用了项目内的相对路径 | 用引擎目录下的绝对路径 |
| 封面空白 / 偏上 | 抽取时刻太早，或标题默认偏上 | 从成片 t≈1.0–1.6s 抽 |
| 便签一片空白 | `b.note()` 的 `dur` ≤ `landDur`(0.4) | 用 `dur: 0.7` 并显式 `textColor` |
| 图形 / 文字层叠成重影 | 缺 `b.erase('all', T.start(id))` | 每幕开头补上 |
| `erased only 0.x s` 提醒成堆 | 收尾文字锚点太靠句尾 | 按 W2 前移；只剩封面便签/脚注两条可接受 |
| 检查器把不同幕的框字错配 | 缺 erase 或 at 落在下一幕 | 检查分幕边界 |

## 交付

三件套齐全、时长与分辨率核对过、封面目视非空白后，用成品卡片交付（不建桌面符号链接）。覆盖已交付成品前先留一份可回滚备份。
