import json, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
src, out = sys.argv[1], sys.argv[2]
streams = json.load(open(src))
urls = sorted({s['url'] for s in streams if not s.get('user_agent') and not s.get('referrer')})
def probe(u):
    try:
        p = subprocess.run(['curl','-sS','-L','--max-redirs','5','-m','10','-r','0-512',
            '-H','Origin: https://example.org','-H','User-Agent: Mozilla/5.0',
            '-D','-','-o','-', '-w','\n__CODE__%{http_code}', u], capture_output=True, timeout=15)
        txt = p.stdout.decode('latin1', 'replace')
        code = int(txt.rsplit('__CODE__',1)[-1] or 0) if '__CODE__' in txt else 0
        cors = 'access-control-allow-origin' in txt.lower()
        body_ok = '#EXTM3U' in txt or '<MPD' in txt
        return u, code, cors, body_ok, p.stderr.decode()[:80]
    except Exception as e:
        return u, 0, False, False, str(e)[:80]
res = {}
with ThreadPoolExecutor(200) as ex:
    for i,(u,c,cors,ok,err) in enumerate(ex.map(probe, urls)):
        res[u] = {'code':c,'cors':cors,'ok':ok,'err':err}
        if i % 1000 == 0: print(i, flush=True)
json.dump(res, open(out,'w'))
print('done', len(res))
