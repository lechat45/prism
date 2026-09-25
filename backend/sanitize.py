"""Nettoyage et validation du HTML renvoyé par le LLM.

Le prompt système interdit le Markdown, mais on ne fait jamais confiance à la
sortie d'un modèle : ce module retire les blocs ```html, la prose avant/après
le document, les balises <think>, puis garantit un document HTML complet.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from html.parser import HTMLParser

_FENCE_RE = re.compile(r"```[\w+-]*[ \t]*\n?(.*?)```", re.S)
_THINK_RE = re.compile(r"<think>.*?</think>", re.S | re.I)
_DOC_START_RE = re.compile(r"<!doctype\s+html|<html[\s>]", re.I)
_TAG_START_RE = re.compile(r"<[a-zA-Z!]")
_EXTERNAL_RE = re.compile(r"""\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?//""", re.I)
# localStorage n'y figure plus : la sandbox fournit un stockage persistant par widget.
_SANDBOX_APIS = {
    "sessionStorage": re.compile(r"\bsessionStorage\b"),
    "document.cookie": re.compile(r"\bdocument\.cookie\b"),
    "fetch()": re.compile(r"\bfetch\s*\("),
}


def clean_llm_output(raw: str) -> str:
    """Extrait le document HTML brut d'une réponse de modèle."""
    text = (raw or "").lstrip("﻿").strip()
    text = _THINK_RE.sub("", text).strip()

    fences = _FENCE_RE.findall(text)
    if fences:
        # Plusieurs blocs possibles : on garde le plus gros qui contient du HTML.
        text = max(fences, key=lambda block: ("<" in block, len(block))).strip()
    else:
        # Bloc non refermé (réponse tronquée) ou fence orpheline.
        text = re.sub(r"^```[\w+-]*[ \t]*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text).strip()

    start = _DOC_START_RE.search(text) or _TAG_START_RE.search(text)
    if start:
        text = text[start.start():]

    closings = [m.end() for m in re.finditer(r"</html>", text, re.I)]
    if closings:
        text = text[: closings[-1]]
    else:
        last_tag = text.rfind(">")
        if last_tag != -1:
            text = text[: last_tag + 1]
    return text.strip()


def has_markup(text: str) -> bool:
    """Faux pour une réponse en prose pure (refus, explication…) : rien à rendre."""
    return bool(_TAG_START_RE.search(text))


def ensure_document(html: str, lang: str = "fr") -> str:
    """Enveloppe un fragment dans un document HTML5 complet si nécessaire."""
    if not re.search(r"<html[\s>]", html, re.I):
        return (
            "<!DOCTYPE html>\n"
            f'<html lang="{lang}">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            "<title>Prism</title>\n</head>\n<body>\n"
            f"{html}\n</body>\n</html>"
        )
    if not re.match(r"\s*<!doctype\s+html", html, re.I):
        html = "<!DOCTYPE html>\n" + html.lstrip()
    return html


_EMPTY_SCRIPT_RE = re.compile(r"<script\b([^>]*)>\s*</script\s*>", re.I)
_SRC_ATTR_RE = re.compile(r"""\bsrc\s*=\s*(["']?)([^"'\s>]+)\1""", re.I)
# chart.js, chart.js@4…, Chart.js/4.4.0/…, …/chart.umd.min.js — mais pas les plugins (chartjs-plugin-…).
_CHARTJS_SRC_RE = re.compile(r"chart\.js(?:@|/|$)|/chart(?:\.umd)?(?:\.min)?\.js(?:$|\?)", re.I)
_USES_CHART_RE = re.compile(r"\bnew\s+Chart\s*\(|\bChart\s*\.\s*(?:register|defaults|getChart|helpers)\b")


def _insert_in_head(html: str, tag: str) -> str:
    head = re.search(r"<head(?:\s[^>]*)?>", html, re.I)
    if head:
        return html[: head.end()] + tag + html[head.end():]
    root = re.search(r"<html(?:\s[^>]*)?>", html, re.I)
    if root:
        return html[: root.end()] + "<head>" + tag + "</head>" + html[root.end():]
    return tag + html


def normalize_libraries(html: str, libs: dict) -> str:
    """Remplace toute balise Chart.js (version ou CDN quelconque) par la version épinglée avec SRI,
    injectée en tête de <head> si le document utilise Chart. Idempotent."""
    chart = libs["chartjs"]

    def drop_chartjs(match: re.Match) -> str:
        src = _SRC_ATTR_RE.search(match.group(1))
        return "" if src and _CHARTJS_SRC_RE.search(src.group(2)) else match.group(0)

    html = _EMPTY_SCRIPT_RE.sub(drop_chartjs, html)
    if _USES_CHART_RE.search(html):
        tag = f'<script src="{chart["url"]}" integrity="{chart["integrity"]}" crossorigin="anonymous"></script>'
        html = _insert_in_head(html, tag)
    return html


class _TagCounter(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.opened: dict[str, int] = {}
        self.closed: dict[str, int] = {}

    def handle_starttag(self, tag, attrs):  # noqa: ANN001
        self.opened[tag] = self.opened.get(tag, 0) + 1

    def handle_endtag(self, tag):  # noqa: ANN001
        self.closed[tag] = self.closed.get(tag, 0) + 1


def validate_document(html: str, allowed_urls: tuple[str, ...] = ()) -> list[str]:
    """Retourne la liste des problèmes détectés (vide = document propre).
    `allowed_urls` : ressources externes autorisées (bibliothèques épinglées)."""
    issues: list[str] = []
    if not html.strip():
        return ["empty_document"]
    if "```" in html:
        issues.append("markdown_fence")
    if not re.match(r"\s*<!doctype\s+html", html, re.I):
        issues.append("missing_doctype")
    if not re.search(r"</html>", html, re.I):
        issues.append("missing_closing_html")

    counter = _TagCounter()
    try:
        counter.feed(html)
        counter.close()
    except Exception:  # HTMLParser est tolérant, mais on reste prudent.
        issues.append("unparseable_html")
    for tag in ("html", "head", "body", "script", "style"):
        if counter.opened.get(tag, 0) != counter.closed.get(tag, 0):
            issues.append(f"unbalanced_<{tag}>")

    checked = html
    for url in allowed_urls:
        checked = checked.replace(url, "")
    if _EXTERNAL_RE.search(checked):
        issues.append("external_resource")
    for name, pattern in _SANDBOX_APIS.items():
        if pattern.search(html):
            issues.append(f"sandbox_api:{name}")
    return issues


_SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.S | re.I)
_JS_TYPES = {"text/javascript", "application/javascript"}
# Analyse chaque script comme un <script> classique de navigateur (vm.Script, sans l'exécuter).
_NODE_CHECKER = (
    "const vm=require('vm');let d='';process.stdin.setEncoding('utf8');"
    "process.stdin.on('data',c=>d+=c).on('end',()=>{const out=[];"
    "JSON.parse(d).forEach((s,i)=>{try{new vm.Script(s,{filename:'script-'+(i+1)+'.js'})}"
    "catch(e){const m=/:(\\d+)/.exec((e.stack||'').split('\\n')[0]);"
    "out.push('script #'+(i+1)+(m?' ligne '+m[1]:'')+': '+e.message)}});"
    "process.stdout.write(JSON.stringify(out))})"
)


def inline_scripts(html: str) -> list[str]:
    """Contenu des <script> inline exécutables (ignore src=, JSON, templates…)."""
    sources = []
    for attrs, body in _SCRIPT_RE.findall(html):
        if re.search(r"\bsrc\s*=", attrs, re.I):
            continue
        declared = re.search(r"""\btype\s*=\s*["']?([\w/+.-]+)""", attrs, re.I)
        if declared and declared.group(1).lower() not in _JS_TYPES:
            continue
        if body.strip():
            sources.append(body)
    return sources


def js_syntax_errors(html: str, timeout: float = 10.0) -> list[str]:
    """Erreurs de syntaxe des scripts inline, via Node.js. Liste vide si Node est absent."""
    node = shutil.which("node")
    sources = inline_scripts(html)
    if not node or not sources:
        return []
    try:
        proc = subprocess.run(
            [node, "-e", _NODE_CHECKER],
            input=json.dumps(sources),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
        )
        return json.loads(proc.stdout or "[]")
    except (OSError, subprocess.SubprocessError, ValueError):
        return []


# Problèmes qui rendent le document inutilisable (les autres sont des avertissements).
BLOCKING_ISSUES = {"empty_document", "markdown_fence", "missing_closing_html", "unbalanced_<script>", "js_syntax"}


def is_blocking(issues: list[str]) -> bool:
    return any(issue in BLOCKING_ISSUES for issue in issues)
