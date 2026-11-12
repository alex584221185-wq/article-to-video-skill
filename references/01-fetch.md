# S0 · 拉取文章

目标：拿到**完整原文**并存成 `article.md`。后面洗稿、拆解、事实核对都以它为准，不要凭对话里的片段动手。

## 飞书 wiki / docx

```bash
lark-cli docs +fetch --doc "<文档 URL 或 token>" \
  --doc-format markdown --as user > /tmp/article.json
```

返回 JSON 里取 `data.document.content` 存成 `article.md`（约 3–4 万字的长文也能一次拿全）：

```python
import json
d = json.load(open('/tmp/article.json'))
open('article.md', 'w').write(d['data']['document']['content'])
```

要点：
- `--as user` 用当前用户身份，避免机器人看不到文档。
- 先看目录再决定要不要全文：`--scope outline --max-depth 3`。
- 记下 `data.document.revision_id`，便于日后判断「文章是否真的更新了」。
- 文档里的图片是 `<img>` 或 `![](...)` 链接，**只作为内容线索，不要直接用到视频里**（版权 + 风格不统一）。

## 本地 Markdown / txt

直接读。若为 PDF / docx，先转成 Markdown 再进入流程。

## 网页文章

用 WebFetch 取正文，或浏览器另存为 Markdown。只保留正文，去掉导航、广告、评论区。

## 拿到后先做两件事

1. **章节结构**：`grep -nE '^#{1,2} ' article.md`，确认一级标题能正确切章。
2. **变更核对**（若声称「文章更新了」）：与上一版逐章比字数差，别只看总行数。

```python
# 按一级/二级标题切章，输出每章标题与字数
import re
lines = open('article.md').read().split('\n')
cur, buf, out = None, [], []
for ln in lines:
    if re.match(r'^#{1,2} ', ln.strip()):
        if cur: out.append((cur, len('\n'.join(buf))))
        cur, buf = ln.strip().lstrip('#').strip(), []
    else:
        buf.append(ln)
if cur: out.append((cur, len('\n'.join(buf))))
for k, n in out: print(f'{n:>7}  {k[:60]}')
```

**实测教训**：有次「文章更新了」，逐章对比后发现正文 15 章几乎没变（每章字数差 < 60 字），增量全在「交流合作」「作者介绍」这类页眉信息，而这些恰恰不能进视频。先核对再规划，能省掉一整轮白做。
