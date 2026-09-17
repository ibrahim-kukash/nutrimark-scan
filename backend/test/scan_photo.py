"""
Send one or more label photos to the deployed backend and print what comes back.
Usage:  python scan_photo.py https://<worker-url>  photo1.jpg [photo2.png ...]
No key is needed on this side: the backend holds the keys.
"""
import base64, json, sys, time, mimetypes, urllib.request
from pathlib import Path

if len(sys.argv) < 3:
    print(__doc__); sys.exit(1)
url = sys.argv[1].rstrip("/") + "/scan"
for path in sys.argv[2:]:
    p = Path(path)
    media = mimetypes.guess_type(p.name)[0] or "image/jpeg"
    body = {"image_base64": base64.b64encode(p.read_bytes()).decode(), "media_type": media, "device_id": "test-script"}
    t0 = time.time()
    # A browser-like User-Agent: Cloudflare's edge refuses the bare Python signature with error 1010.
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", "Origin": "http://127.0.0.1:8888",
                                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NutriMarkScanTest/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"{p.name}: HTTP {e.code} {e.read().decode()[:300]}"); continue
    dt = time.time() - t0
    rd = data.get("reading", {})
    g = data.get("grade") or {}
    print(f"\n== {p.name}  ({dt:.1f} s, cached={data.get('cached', False)})")
    print(f"   product: {rd.get('product_name')} | category: {rd.get('category')} | basis: {rd.get('basis')} serving={rd.get('serving_size')}")
    print(f"   values : {json.dumps(rd.get('values'))}")
    print(f"   per100 : {json.dumps(data.get('per100'))}")
    print(f"   checks : {[c['code'] for c in data.get('checks', [])]}  decision: {data.get('decision')}")
    print(f"   grade  : {g.get('grade')} score={g.get('score')} N={g.get('N')} P={g.get('P')} reasons={data.get('reasons')} flags={data.get('flags')}")
    print(f"   passes : {[(x.get('model'), x.get('usage')) for x in data.get('passes', [])]}")
