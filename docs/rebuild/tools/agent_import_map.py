#!/usr/bin/env python3
"""Static @import map of src/core/agent: who imports it and what it imports. Read-only.

    python3 docs/rebuild/tools/agent_import_map.py

Counts path imports of .zig files only. Edges that exist through comptime generics or injected
context (for example `app_agent_runtime.Runtime(Self)`) are not visible to it, so every number is a
lower bound on coupling.
"""
import re, os, collections
ROOT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','..')
os.chdir(ROOT)
ROOT='src'
files=[os.path.join(d,f) for d,_,fs in os.walk(ROOT) for f in fs if f.endswith('.zig')]
fset=set(files)
imp=re.compile(r'@import\("([^"]+)"\)')
graph={}; named=collections.defaultdict(set)
for f in files:
    txt=open(f,errors='ignore').read()
    out=set()
    for m in imp.findall(txt):
        if m.endswith('.zig'):
            p=os.path.normpath(os.path.join(os.path.dirname(f),m))
            if p in fset: out.add(p)
        elif m!='std' and m!='builtin':
            named[f].add(m)
    graph[f]=out
rev=collections.defaultdict(set)
for a,bs in graph.items():
    for b in bs: rev[b].add(a)
def area(p):
    parts=p.split('/')
    return '/'.join(parts[:3]) if parts[1]=='core' and len(parts)>3 else '/'.join(parts[:2]) if len(parts)>2 else p
A='src/core/agent/'
agent=[f for f in files if f.startswith(A)]
tests=[f for f in agent if '/tests/' in f or f.endswith('_test.zig') or f.endswith('_tests.zig')]
loc=lambda fs: sum(len(open(f,errors='ignore').read().splitlines()) for f in fs)
print('agent files',len(agent),'lines',loc(agent),'| test files',len(tests),'lines',loc(tests))
# inbound: outside files importing agent files
inb=collections.defaultdict(set)
for f in agent:
    for r in rev[f]:
        if not r.startswith(A): inb[area(r)].add((r,f))
print('\nINBOUND (outside importer area -> #importer files, #agent files used)')
for a,s in sorted(inb.items(), key=lambda kv:-len({x for x,_ in kv[1]})):
    print(f'  {a:40} {len({x for x,_ in s}):4} importers -> {len({y for _,y in s}):3} agent files')
out=collections.defaultdict(set)
for f in agent:
    for d in graph[f]:
        if not d.startswith(A): out[area(d)].add((f,d))
print('\nOUTBOUND (agent -> area: #agent files, #target files)')
for a,s in sorted(out.items(), key=lambda kv:-len({x for x,_ in kv[1]})):
    print(f'  {a:40} {len({x for x,_ in s}):4} agent files -> {len({y for _,y in s}):3} target files')
print('\nnamed (non-path) imports from agent:', sorted({m for f in agent for m in named[f]}))
# cycles: does anything agent imports (transitively, outside agent) import agent back?
def reach(starts):
    seen=set(); st=list(starts)
    while st:
        x=st.pop()
        if x in seen: continue
        seen.add(x); st.extend(graph.get(x,()))
    return seen
outside_targets={d for f in agent for d in graph[f] if not d.startswith(A)}
r=reach(outside_targets)
cyc=sorted({x for x in r if x.startswith(A)})
print('\nagent files reachable from agent\'s own outside dependencies (cycle through other areas):',len(cyc))
# top-level agent files with the most inbound
print('\nMOST-IMPORTED agent files from outside:')
c=collections.Counter()
for f in agent:
    c[f]=len({r for r in rev[f] if not r.startswith(A)})
for f,n in c.most_common(15): print(f'  {n:3} {f} ({loc([f])} lines)')
i, o = set(inb), set(out)
print('\nmutual (agent imports them and they import agent):', ', '.join(sorted(i & o)))
print('only import agent:', ', '.join(sorted(i - o)))
print('only imported by agent:', ', '.join(sorted(o - i)))
