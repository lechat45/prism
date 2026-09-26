"""Vérifie un Prism déployé : santé, en-têtes de sécurité, CORS pour GitHub Pages, frontend, authentification.

Usage :  python tools/check_deploy.py https://prism-api.onrender.com [--origin https://lechat45.github.io]
Lecture seule : aucun compte créé, aucune génération (aucun Spark dépensé). Code de sortie 1 si un contrôle échoue.
Un service gratuit endormi peut mettre ~1 minute à répondre au premier appel : le délai est large.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

results: list[tuple[bool, str, str]] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    results.append((bool(ok), label, detail))


def request(method: str, url: str, headers: dict | None = None, body: bytes | None = None, timeout: float = 90):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, {k.lower(): v for k, v in res.headers.items()}, res.read()
    except urllib.error.HTTPError as err:
        return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("base", help="adresse du service, ex. https://prism-api.onrender.com")
    parser.add_argument("--origin", default="https://lechat45.github.io", help="origine du frontend GitHub Pages")
    parser.add_argument("--allow-demo", action="store_true", help="accepter le mode démo (sans clé de modèle), ex. en CI")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    t0 = time.perf_counter()
    status, headers, body = request("GET", f"{base}/api/health")
    elapsed = time.perf_counter() - t0
    info = json.loads(body or b"{}") if status == 200 else {}
    check("GET /api/health répond", status == 200 and info.get("status") == "ok",
          f"HTTP {status} en {elapsed:.1f} s — v{info.get('version')} · moteur {info.get('mode')} · {', '.join(info.get('providers') or []) or 'démo'}")
    check("moteur réel configuré (GEMINI_API_KEY)", info.get("mode") not in (None, "mock") or (args.allow_demo and info.get("mode") == "mock"),
          "mode démo : ajoutez GEMINI_API_KEY" if info.get("mode") == "mock" else info.get("mode", ""))
    check("comptes activés", info.get("auth") is True)

    for name, expected in (("x-content-type-options", "nosniff"), ("x-frame-options", "DENY"), ("referrer-policy", "no-referrer")):
        check(f"en-tête {name}", headers.get(name) == expected, headers.get(name, "absent"))
    if base.startswith("https://"):
        check("en-tête strict-transport-security", "max-age" in headers.get("strict-transport-security", ""),
              headers.get("strict-transport-security", "absent (PRISM_ENV=production ?)"))

    status, headers, _ = request("OPTIONS", f"{base}/api/widgets/x/file", headers={
        "Origin": args.origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization,content-type",
    })
    allowed = headers.get("access-control-allow-origin", "")
    check(f"CORS : {args.origin} autorisé", status == 200 and allowed in (args.origin, "*"), f"HTTP {status}, allow-origin « {allowed} »")
    check("CORS : PUT et Authorization autorisés",
          "PUT" in headers.get("access-control-allow-methods", "") and "authorization" in headers.get("access-control-allow-headers", "").lower())

    status, headers, body = request("GET", f"{base}/")
    check("frontend servi (GET /)", status == 200 and b"Prism" in body, f"HTTP {status}, {headers.get('content-type', '')}")

    status, _, body = request("POST", f"{base}/api/generate", headers={"Content-Type": "application/json"}, body=b'{"prompt":"test"}')
    check("génération refusée sans compte (401)", status == 401, f"HTTP {status}")

    for ok, label, detail in results:
        print(f"  {'OK   ' if ok else 'ÉCHEC'}  {label}{f'  ({detail})' if detail else ''}")
    failed = [r for r in results if not r[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} contrôles réussis")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
