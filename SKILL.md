---
name: article-to-video
description: 把一篇长文章／飞书文档变成一套竖屏白板讲解视频的端到端流水线。覆盖「拉取文章 → 原创改写洗稿 → 章节拆解与分集规划 → 建项目 → 质量门禁 → 渲染归档」。凡用户说「根据这篇文章做视频」「把文档做成系列」「洗稿后拆成几集」「新开一个系列」「补上漏掉的章节」，或需要复用 Grok Bot 那套白板动画流程时使用。自带检查器与模板，跨窗口可用。
agent_created: true
---

# article-to-video · 文章到视频流水线

把一份长材料变成一套可直接发布的 9:16 白板手绘讲解视频。这套流程来自一个真实跑完的 9 集系列，里面的阈值和红线都是实测出来的，不是通用建议。

## 何时用

- 拿到一篇新文章／飞书 wiki／docx，要做成系列视频
- 已有系列要续做，需要判断「哪些还没做过」
- 单纯要洗稿、拆解、或复用白板动画制作规范

## 依赖（首次填一次）

| 依赖 | 用途 | 怎么找 |
|---|---|---|
| `lark-cli` | 拉飞书文档（文章在本地可跳过） | 飞书连接器已装则有 |
| `bb-video` 引擎 | 白板动画渲染 | `~/.workbuddy/skills/bb-video/` |
| `node` / `python3` / `ffmpeg` / `ffprobe` | 渲染与抽帧 | 本机 |
| `qa.mjs`、模板 | **已自带**在本 skill 的 `scripts/` `templates/` | 无需外部 skill |

把 `scripts/paths.env.example` 复制成 `scripts/paths.env` 填一次本机路径即可；不填时按 `references/04-render.md` 里的探测命令自动定位。

## 六步流程

### S0 拉取文章
飞书：`lark-cli docs +fetch --doc "<url>" --doc-format markdown --as user > article.json`，取 `data.document.content` 存成 `article.md`。
本地文件直接读。**先存全文再动手**，后面拆解和事实核对都要用原文。
细节见 `references/01-fetch.md`。

### S1 洗稿（原创改写 + 事实底稿）
不是换词，是**把材料改写成自己的教学脚本**，同时建立可回查的事实底稿 `brief.md`：
- 「事实来源对照」：逐条写明结论来自文章哪一部分
- 「On-screen text」：屏幕上出现的每一个字符串逐条登记，改字必须同步改
红线与模板见 `references/02-rewrite.md`、`templates/brief.md`。

### S2 拆解（分集规划）
1. `python3 scripts/density.py article.md` → 每章字数／提示词／表格／要点，按阈值判断一章一集还是合并。
2. `python3 scripts/coverage.py article.md <已交付视频目录>` → **线索对照表**：哪章在哪些已交付视频里出现过线索、哪些专有词一次都没出现。它不下「已覆盖/未覆盖」结论（实测误判过），必须逐条打开 `brief.md` 核对。
3. 写分集方案（`templates/plan.md`）：每集编号、对应章、钩子、核心画面、句数、时长、与旧片关系。

**默认口径：只补从未讲过的章节，不重制、不拆分、不改已发布视频。** 用户明确说「重制／细化」时才改口径。上一版方案曾把三个已做过的实操重制排进计划，被一句话否掉 —— 「做过但压缩」不等于「漏掉」。
拆解阈值、覆盖判断、编号规则见 `references/03-split.md`。

### S3 建项目（每一集）
复制引擎依赖（`lib/`、`assets/`、`characters.js`）→ `templates/skeleton.html` 存成 `index.html` → 写 `script.json`（旁白，把可锚的对应词埋在句子前 2/3）→ 生成 `brief.md`。
**禁止手写 `x+150`、`60+i*330` 这类坐标偏移**，一律用骨架里的 `cols/card/cardLines/banner` 声明式助手。

### S4 质量门禁（渲染前，缺一不可）
```
python3  <bb-video>/explainer/scripts/tts.py <项目>
node     scripts/qa.mjs <项目> --aspect 9:16        # 必须 0 error
node     <bb-video>/explainer/scripts/render.mjs <项目> --check --aspect 9:16   # 必须 0 error
node     ... --stills <每幕一个时间点> --aspect 9:16 # 抽帧目视，每幕至少一帧
```
`qa.mjs` 查：越界、压框线、未在框内居中、同列压叠、锚点没落在对应句口播、屏幕文案没登记 brief.md；另给两条提醒（无所属框的文字 W1、一幕里过半锚点挤在句尾 W2）。
引擎 `--check` 查：出画面、重叠、停留太短、事实核对。

**两道门禁查不出的事，必须靠人眼**：字形观感、逐词点亮的节奏、画面长时间只有标题。抽帧时若某幕前 2/3 只有标题，把主视觉锚点换成句子前半段的对应词（例：卡片「结果」锚 `做成什么` 而非 `结果`）。

### S5 渲染与归档
正式渲染**必须后台跑**（前台长渲染在会话结束时会收到 SIGKILL）。完成后抽 t=1.0s 封面（不要用引擎自动导出的 cover，它可能抽在文字揭示之前得到空封面），复制字幕，归档三件套：
```
<OUTPUT_ROOT>/<系列总文件夹>/<编号. 作品名>/
    作品名·成片.mp4 / 作品名·封面.png / 作品名·字幕.srt
```
归档用复制而非移动，覆盖已交付成品前留一份可回滚备份。最后用成品卡片交付，不建桌面快捷方式。
完整命令与探测方法见 `references/04-render.md`。

## 硬规则（踩过的坑）

1. **不出现作者名、出品方、机构名、品牌背书、价格**；案例一律标「教学演示／虚构样例」，不写成真实客户案例。
2. **不承诺效果**：升学率、通过率、保过、效率翻倍等表述禁用（《广告法》第 24 条），改用事实陈述。
3. 涉及境外服务，保留「用之前先确认你所在地区能不能用」。
4. 术语全片统一；不直接用原文里的图片（版权 + 风格），重绘成手绘示意。
5. `script.json` 的 `lead_in` / `gap` / `tail` 是顶层字段；`bgm: "bright"`、`lead_in: 1.2` 保证封面和 BGM 同时起，别浪费前两秒。
6. 每幕开头必须 `b.erase('all', T.start(id))` —— 检查器靠它分幕，缺了会把不同幕的框和字错配。
7. 锚点 `W_(id, phrase)` 的 phrase 必须在该句口播里真实出现，否则回退句首造成顺序错位。
8. 封面便签 `dur` 必须 > 0.4（`landDur`），并显式给 `textColor`，否则便签一片空白。
9. 渲染前 `qa.mjs` 0 error；`--check` 若「erased only 0.x s」提醒超过 3 条，说明收尾锚点太靠后，前移后再渲染。
10. 竖屏字幕在约 78% 高度，内容与文字不进 y>1500；安全栅格见 `templates/skeleton.html` 的 `cols()`。

## 新窗口开场口令

粘这一句即可，不必复述上面的坑：

> 按用户级 skill `article-to-video` 处理这篇文章：先拉全文，洗稿建 brief.md，用 density.py / coverage.py 拆解并只补从未讲过的章节，再用骨架建项目，渲染前 qa.mjs 与 --check 都要 0 error 并抽帧目视，最后后台渲染归档三件套。

## 能力边界

`density.py` / `coverage.py` 只给线索，不做最终判断：关键词命中率受术语变体影响，「是否讲过」仍要逐条比对已交付视频的 `brief.md` 屏幕文案清单。`qa.mjs` 是几何与语义检查，查不出观感和节奏，抽帧目视不能省。
