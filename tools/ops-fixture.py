# Test-only Linux fixture. Never imported by the product or installed remotely.
import base64,json,os,pathlib,signal,subprocess,tempfile

def run(args,check=True):
    p=subprocess.run(args,capture_output=True,text=True,timeout=25)
    if check and p.returncode:raise RuntimeError('fixture command failed: '+args[0]+' '+p.stderr[:300])
    return p

def docker(*args,check=True):return run(['docker','--host','unix:///var/run/docker.sock',*args],check)
def start(pid):
    try:
        text=pathlib.Path('/proc/%d/stat'%pid).read_text()
        return text[text.rfind(')')+2:].split()[19]
    except FileNotFoundError:return None

def owned(data):
    root=pathlib.Path(data['root']);assert root.name.startswith('serverdeck-ops-e2e-'+data['uuid'])
    assert root.parent==pathlib.Path(tempfile.gettempdir()) and root.resolve()==root and not root.is_symlink()
    return root

def create(data):
    uid=data['uuid'];assert len(uid)==36 and all(c in '0123456789abcdef-' for c in uid)
    root=pathlib.Path(tempfile.mkdtemp(prefix='serverdeck-ops-e2e-'+uid+'-'));data['root']=str(root)
    (root/'scope.json').write_text(json.dumps(data))
    images=[json.loads(l) for l in docker('image','ls','--no-trunc','--format','{{json .}}').stdout.splitlines() if l]
    images.sort(key=lambda v:0 if v.get('Repository','').split('/')[-1] in ('busybox','alpine') else 1)
    seed='serverdeck-e2e-'+uid+'-seed'
    for image in images[:8]:
        result=docker('create','--name',seed,'--label','cn.hiboot.e2e='+uid,'--network','none','--entrypoint','/bin/sh',image['ID'],'-c','exit 0',check=False)
        if result.returncode:continue
        data['seed']=result.stdout.strip();(root/'scope.json').write_text(json.dumps(data))
        result=docker('start','--attach',seed,check=False)
        if result.returncode==0:break
        docker('rm',seed);data.pop('seed',None)
    if not data.get('seed'):raise RuntimeError('No existing Linux image with /bin/sh; test will not pull images automatically')
    data['image']=docker('commit','--change','LABEL cn.hiboot.e2e='+uid,seed,'serverdeck-e2e-'+uid+':fixture').stdout.strip()
    docker('rm',seed);data.pop('seed',None);(root/'scope.json').write_text(json.dumps(data))
    script='i=0; while test $i -lt 3600; do printf "__SD_DOCKER_%s__ 中文 %%s\\n" "$i"; printf "__SD_STDERR_%s__\\n" >&2; i=$((i+1)); sleep 1; done'%(uid,uid)
    data['container']=docker('create','--name','serverdeck-e2e-'+uid,'--label','cn.hiboot.e2e='+uid,'--cpus','0.25','--memory','64m','--pids-limit','32','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--publish','127.0.0.1::8080','--mount','type=bind,source='+str(root)+',target=/test-data,readonly','--env','SD_E2E_SECRET=protect-'+uid,'--entrypoint','/bin/sh',data['image'],'-c',script).stdout.strip()
    (root/'scope.json').write_text(json.dumps(data));return data

def cleanup(data):
    if 'root' not in data:
        roots=list(pathlib.Path(tempfile.gettempdir()).glob('serverdeck-ops-e2e-'+data['uuid']+'-*'))
        if not roots:return {'cleaned':True}
        assert len(roots)==1 and not roots[0].is_symlink()
        data=json.loads((roots[0]/'scope.json').read_text())
    root=owned(data)
    directory_absent=not root.exists()
    if (root/'scope.json').exists():data=json.loads((root/'scope.json').read_text())
    uid=data['uuid']
    for key in ('container','seed'):
        if data.get(key):
            p=docker('container','inspect','--format','{{index .Config.Labels "cn.hiboot.e2e"}}',data[key],check=False)
            if p.returncode==0:
                assert p.stdout.strip()==uid
                docker('stop','--time','2',data[key],check=False);docker('rm',data[key])
            elif 'no such' not in p.stderr.lower():raise RuntimeError('Unable to verify fixture container absence')
    if data.get('image'):
        p=docker('image','inspect','--format','{{index .Config.Labels "cn.hiboot.e2e"}}',data['image'],check=False)
        if p.returncode==0:
            assert p.stdout.strip()==uid;docker('image','rm',data['image'])
        elif 'no such' not in p.stderr.lower():raise RuntimeError('Unable to verify fixture image absence')
    for name in ('sleep','port','kill','append'):
        pid=data.get(name+'Pid');expected=data.get(name+'Start')
        if pid and start(pid)==expected:
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
    # Compatibility cleanup for explicitly recovered older fixture scopes.
    if data.get('unit'):
        unit=data['unit'];assert unit=='serverdeck-e2e-'+uid+'.service'
        run(['systemctl','--user','--no-ask-password','stop',unit],False);run(['systemctl','--user','--no-ask-password','disable',unit],False)
        path=pathlib.Path(data['unitPath'])
        if path.exists():
            assert path.name==unit and ('# serverdeck-owned '+uid) in path.read_text();path.unlink()
        run(['systemctl','--user','--no-ask-password','daemon-reload'])
    if root.exists():
        for path in root.iterdir():
            if path.name not in ('scope.json','unit-lease',pathlib.Path(data.get('log','')).name):raise RuntimeError('Unexpected fixture file; retained for review')
            assert not path.is_symlink();path.unlink()
        root.rmdir()
    return {'cleaned':True,'directoryAlreadyAbsent':directory_absent}

def status(data):
    owned(data)
    streams=[]
    for path in pathlib.Path('/proc').iterdir():
        if not path.name.isdigit():continue
        try:
            cmd=(path/'cmdline').read_bytes().split(b'\0');name=(path/'comm').read_text().strip()
            if (name=='docker' and b'logs' in cmd and data['container'].encode() in cmd):streams.append(int(path.name))
        except (PermissionError,FileNotFoundError,ProcessLookupError):pass
    return {'streamProcesses':streams}

try:
    if mode=='create':result=create(data)
    elif mode=='cleanup':result=cleanup(data)
    elif mode=='status':result=status(data)
    else:raise ValueError('unknown fixture mode')
except Exception as exc:
    result={'error':str(exc),'scope':data}
print('__SD_OP'+'S_REF__'+base64.b64encode(json.dumps(result).encode()).decode()+'__SD_OP'+'S_END__')
