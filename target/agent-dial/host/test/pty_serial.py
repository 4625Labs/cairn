import os, pty, sys, time, subprocess, tty, json, tempfile
sys.path.insert(0,'tests')
m, s = pty.openpty()
tty.setraw(m); name = os.ttyname(s)
home = tempfile.mkdtemp(prefix='adp-')
env = dict(os.environ, AGENT_DIAL_HOME=home, AGENT_DIAL_SOCKET=home+'/hub.sock', AGENT_DIAL_PORT=name, AGENT_DIAL_NO_SPAWN='1')
hub = subprocess.Popen(['node','hub.mjs'], env=env)
def crc(d):
    c=0xFFFF
    for b in d:
        c^=b<<8
        for _ in range(8): c=((c<<1)^0x1021)&0xFFFF if c&0x8000 else (c<<1)&0xFFFF
    return c
def frame(p):
    body=bytes([1,1,len(p)&255,len(p)>>8])+p; c=crc(body); return b'\xa5\x45'+body+bytes([c&255,c>>8])
time.sleep(2.5)
os.write(m, frame(json.dumps({"t":"hello","product":"agent-dial","proto":1,"hw":"m5stack-stopwatch","mac":"AA:BB:CC:DD:12:34","fw":"pty","wifi":"none","ip":"","paired":False,"key":"-"}).encode()))
time.sleep(1.0)
import select
got=b''
while select.select([m],[],[],0.3)[0]: got+=os.read(m,4096)
hub.terminate()
print('welcome' in got.decode('latin1'), 'pair' in got.decode('latin1'))
