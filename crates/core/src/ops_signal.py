import os,sys,signal
pid=int(sys.argv[1])
if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):
    sys.exit('此系统缺少 pidfd 支持，未发送信号')
fd=os.pidfd_open(pid,0)
try:
    boot=open('/proc/sys/kernel/random/boot_id').read().strip()
    stat=open('/proc/%d/stat'%pid).read()
    start=stat[stat.rfind(')')+2:].split()[19]
    if boot!=sys.argv[3] or start!=sys.argv[2]:
        sys.exit('PID 对应进程已变化，未发送信号，请刷新详情')
    signal.pidfd_send_signal(fd,getattr(signal,sys.argv[4]),None,0)
    print('信号已发送')
finally:
    os.close(fd)
