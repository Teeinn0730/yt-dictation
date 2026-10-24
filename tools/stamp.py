"""部署前執行：依檔案內容算出版本號，寫進 index.html。

GitHub Pages 會讓瀏覽器把每個檔案快取 10 分鐘，更新後可能出現「新的 HTML + 舊的 JS」混在一起。
這裡替 style.css、js/app.js 和所有 JS 模組（透過 import map）加上 ?v=版本號：
拿到新 HTML 的瀏覽器一定會抓對應的新 JS，拿到舊 HTML 的則整組都用舊的，不會混用。

用法：python tools/stamp.py
"""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"

modules = sorted(p.name for p in (ROOT / "js").glob("*.js"))
digest = hashlib.sha1()
for path in [ROOT / "style.css", *[ROOT / "js" / m for m in modules]]:
    digest.update(path.read_bytes())
version = digest.hexdigest()[:8]

importmap = json.dumps(
    {"imports": {f"./js/{m}": f"./js/{m}?v={version}" for m in modules}},
    ensure_ascii=False,
    indent=2,
)
block = f'<script type="importmap">\n{importmap}\n  </script>'

html = INDEX.read_text(encoding="utf-8")
html = re.sub(r'<script type="importmap">.*?</script>', lambda _: block, html, flags=re.S)
if '<script type="importmap">' not in html:
    html = html.replace('<script type="module"', block + '\n  <script type="module"', 1)
html = re.sub(r'href="style\.css(\?v=[^"]*)?"', f'href="style.css?v={version}"', html)
html = re.sub(r'src="js/app\.js(\?v=[^"]*)?"', f'src="js/app.js?v={version}"', html)
INDEX.write_text(html, encoding="utf-8")
print(f"stamped version {version} ({len(modules)} modules)")
