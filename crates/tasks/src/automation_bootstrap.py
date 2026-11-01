import json,os,sys
try:
 b=sys.stdin.buffer.read(262145)
 if len(b)>262144: raise ValueError()
 p=json.loads(b)
 script=p['script']; args=p['args']
 if not isinstance(script,str) or not script.strip() or len(script.encode())>65536 or '\0' in script: raise ValueError()
 if not isinstance(args,list) or len(args)>32: raise ValueError()
 if any(not isinstance(a,str) or '\0' in a or len(a.encode())>4096 for a in args): raise ValueError()
 if sum(len(a.encode()) for a in args)>65536: raise ValueError()
except Exception:
 sys.stderr.write('ServerDeck script input rejected\n');sys.exit(64)
os.execv('/bin/sh',['sh','-c',script,'serverdeck-task',*args])
