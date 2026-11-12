#!/usr/bin/env python3
"""统计文章每章的信息密度，给出分集建议。

用法:
    python3 density.py article.md [--json]

只把「第 X 章」当作正式章节。页眉/前置信息（适用人群、作者介绍、交流合作等）
按内容红线不进视频；附录、名词速查这类信息密度低且无画面可做的，改图文。

阈值来自一个真实跑完的 9 集白板系列：
    1500-2200 字  -> 正好一集（8-9 句旁白 / 150-175 秒）
    < 1000        -> 太薄，考虑与相邻章合并或只做图文
    > 3500        -> 拆两集
"""
import json
import re
import sys

THIN = 1000
IDEAL = (1500, 2200)
HEAVY = 3500
CH = re.compile(r'^第[一二三四五六七八九十百零\d]+章')
FRONT = re.compile(r'适用人群|学习目标|作者介绍|交流合作|前言|概述|路线总览|版权|免责')
APPENDIX = re.compile(r'附录|名词速查|官方资料|版本维护|术语表')


def clean(text):
    """去掉图片、链接与 callout 标签，避免把 alt 文本算成正文。"""
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


def stats(body):
    return {
        'chars': len(re.sub(r'\s', '', body)),
        'prompts': len(re.findall(r'^>\s', body, re.M)),
        'tables': body.count('|-'),
        'bullets': len(re.findall(r'^\s*-\s', body, re.M)),
    }


def kind(title):
    if FRONT.search(title):
        return 'front'
    if APPENDIX.search(title):
        return 'appendix'
    if CH.match(title):
        return 'chapter'
    return 'front'


def advise(s, k):
    if k == 'front':
        return '页眉/前置信息：按红线不进视频'
    if k == 'appendix':
        return '不做视频：改图文或置顶'
    n = s['chars']
    if n < THIN:
        return '太薄：与相邻章合并，或只做图文'
    if n <= IDEAL[1]:
        return '一章一集（8-9 句 / 150-175 秒）'
    if n <= HEAVY:
        return '一集，但需砍掉次要分支'
    return '拆两集（按概念/实操 或 低风险/高风险切）'


def main():
    argv = sys.argv[1:]
    as_json = '--json' in argv
    path = next((a for a in argv if not a.startswith('--')), None)
    if not path:
        print(__doc__)
        sys.exit(2)
    rows = []
    for title, body in sections(path):
        s, k = stats(body), kind(title)
        rows.append({'chapter': title, 'kind': k, **s, 'advice': advise(s, k)})
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    chapters = [r for r in rows if r['kind'] == 'chapter']
    others = [r for r in rows if r['kind'] != 'chapter']
    print(f"{'正式章节':<48}{'字数':>7}{'提示词':>7}{'表格':>6}{'要点':>6}  建议")
    print('-' * 108)
    for r in chapters:
        print(f"{r['chapter'][:46]:<48}{r['chars']:>7}{r['prompts']:>7}{r['tables']:>6}{r['bullets']:>6}  {r['advice']}")
    total = sum(r['chars'] for r in chapters)
    print('-' * 108)
    print(f"正式章节 {len(chapters)} 章 / {total} 字。单集容量约 {IDEAL[0]}-{IDEAL[1]} 字；"
          f"3 章共 5000+ 字压进一集属 3.3 倍超载。")
    if others:
        print(f"\n以下 {len(others)} 节不参与分集（页眉或附录，按内容红线处理）：")
        for r in others:
            print(f"  · {r['chapter'][:46]:<48} {r['advice']}")


if __name__ == '__main__':
    main()
