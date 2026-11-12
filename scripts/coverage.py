#!/usr/bin/env python3
"""文章章节 vs 已交付视频的「线索对照表」。

用法:
    python3 coverage.py article.md <已交付项目根目录> [--json]

本脚本**不下「已覆盖 / 未覆盖」的结论**。关键词命中率受术语变体影响很大：
实测中，完全没做过的章节因通用词命中被判成「已覆盖」，讲过的章节因换了说法
被判成「未覆盖」。所以它只做一件事：把「哪一章在哪些已交付视频里出现过线索、
哪些专有词一次都没出现」摆出来，由人逐条打开 brief.md 核对。

判读方法见 references/03-split.md：只有「整章主体方法从未出现」才算漏章；
「做过但压缩」不算。
"""
import json
import os
import re
import sys

CJK = r'\u4e00-\u9fff'
CH = re.compile(r'^第[一二三四五六七八九十百零\d]+章')
FRONT = re.compile(r'适用人群|学习目标|作者介绍|交流合作|前言|概述|路线总览|版权|免责')
APPENDIX = re.compile(r'附录|名词速查|官方资料|版本维护|术语表')


def norm(s):
    return re.sub(f'[^{CJK}A-Za-z0-9]', '', s).lower()


def clean(text):
    text = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', text)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'</?callout[^>]*>', '', text)
    return text


def sections(path):
    lines = open(path, encoding='utf-8').read().split('\n')
    out, cur, buf = [], None, []
    for ln in lines:
        if re.match(r'^# (?!#)', ln):
            if cur is not None:
                out.append((cur, clean('\n'.join(buf))))
            cur, buf = ln.lstrip('#').strip(), []
        else:
            buf.append(ln)
    if cur is not None:
        out.append((cur, clean('\n'.join(buf))))
    return out


def find_briefs(root):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {'.git', 'node_modules', 'out', 'review', 'audio'}]
        if 'brief.md' in filenames:
            hits.append(os.path.join(dirpath, 'brief.md'))
        if len(hits) > 200:
            break
    return sorted(hits)


def on_screen(text):
    m = re.search(r'##\s*On-screen text[^\n]*\n([\s\S]*?)(?=\n##|\n#\s|$)', text, re.I)
    return m.group(1) if m else text


def key_terms(title, body):
    """标题 + 加粗短语 + 表格首列，取 2-12 字词。"""
    raw = [re.sub(r'[｜|].*$', '', re.sub(r'^第[一二三四五六七八九十百零\d]+章[：:｜|]?', '', title))]
    raw += re.findall(r'\*\*([^*]{2,20})\*\*', body)
    for line in body.split('\n'):
        if line.strip().startswith('|'):
            cells = [c.strip() for c in line.strip().strip('|').split('|')]
            if cells and cells[0] and not set(cells[0]) <= set('-: '):
                raw.append(cells[0])
    terms = []
    for r in raw:
        for p in re.split(f'[^{CJK}A-Za-z0-9]+', r):
            if 2 <= len(p) <= 12 and p not in terms:
                terms.append(p)
    return terms


def distinctive(term):
    """区分度高的词：>=4 个中文，或含英文字母。通用词不算。"""
    return len(term) >= 4 or bool(re.search(r'[A-Za-z]', term))


def main():
    argv = sys.argv[1:]
    as_json = '--json' in argv
    args = [a for a in argv if not a.startswith('--')]
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    article, root = args[0], args[1]
    briefs = find_briefs(root)
    if not briefs:
        print(f'未在 {root} 找到任何 brief.md。请传工作区项目根目录（每集一个子目录，含 brief.md）。')
        sys.exit(2)
    corpus = []
    for b in briefs:
        corpus.append((os.path.basename(os.path.dirname(b)) or os.path.basename(b),
                       norm(on_screen(open(b, encoding='utf-8').read()))))

    rows = []
    for title, body in sections(article):
        if FRONT.search(title) or APPENDIX.search(title) or not CH.match(title):
            rows.append({'chapter': title, 'skipped': True, 'reason': '页眉/前置信息或附录，按红线不进视频'})
            continue
        terms = key_terms(title, body)
        hit_videos, hit_terms, miss_terms = set(), [], []
        for t in terms:
            n = norm(t)
            if not n:
                continue
            owners = [name for name, text in corpus if n in text]
            if owners:
                hit_terms.append(t)
                hit_videos.update(owners)
            else:
                miss_terms.append(t)
        rows.append({
            'chapter': title,
            'skipped': False,
            'chars': len(re.sub(r'\s', '', body)),
            'terms': len(terms),
            'hit_terms': len(hit_terms),
            'hit_videos': sorted(hit_videos),
            'miss_distinctive': [t for t in miss_terms if distinctive(t)][:10],
            'miss_sample': miss_terms[:8],
        })

    if as_json:
        print(json.dumps({'briefs': len(briefs), 'brief_names': [n for n, _ in corpus], 'chapters': rows},
                         ensure_ascii=False, indent=2))
        return

    print(f"已读取 {len(briefs)} 份 brief.md：{root}")
    print(f"{'章节':<44}{'字数':>7}{'词':>5}{'命中':>6}{'关联集':>7}  未命中的专有词（前几个）")
    print('-' * 112)
    for r in rows:
        if r['skipped']:
            continue
        sample = '、'.join(r['miss_distinctive'][:4]) or '—'
        print(f"{r['chapter'][:42]:<44}{r['chars']:>7}{r['terms']:>5}{r['hit_terms']:>6}"
              f"{len(r['hit_videos']):>7}  {sample[:36]}")
    print('-' * 112)

    zero = [r for r in rows if not r['skipped'] and not r['hit_videos']]
    print('\n【优先核对】在任一已交付视频里都没有命中线索的章节'
          '（可能是术语变体，也可能是真漏；务必打开 brief.md 核对）：')
    if zero:
        for r in zero:
            print(f"  · {r['chapter'][:52]}")
    else:
        print('  无（每章都至少有一个词命中过，但通用词命中不代表讲过）')

    print('\n【关联集明细】命中词出现在哪些已交付视频里（用于打开对应 brief.md 逐条核对）：')
    for r in rows:
        if r['skipped'] or not r['hit_videos']:
            continue
        print(f"  {r['chapter'][:40]:<42} → {', '.join(r['hit_videos'][:5])}"
              f"{' …' if len(r['hit_videos']) > 5 else ''}")

    skipped = [r for r in rows if r['skipped']]
    if skipped:
        print(f"\n另有 {len(skipped)} 节页眉/附录不参与覆盖判断（按内容红线不进视频）。")

    print('\n⚠ 本表是线索，不是结论。判定「是否漏章」必须逐条打开 brief.md 的 '
          'On-screen text 清单：整章主体方法从未出现才算漏；换过说法、压缩合讲都不算。\n'
          '实测：完全没做过的章节曾因通用词命中被误判「已覆盖」，讲过的章节曾因换说法被误判「未覆盖」。')


if __name__ == '__main__':
    main()
