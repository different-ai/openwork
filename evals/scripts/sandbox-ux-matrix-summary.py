"""Summarize a sandbox UX evidence directory, without overwriting raw evidence."""
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from statistics import median

root = Path(sys.argv[1])


def load(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def fmt(value):
    return round(value) if value is not None else 'NM'


def detailed(run, scenario):
    timing = load(run / 'timings.json', {})
    lookup = {row['metric']: row['ms'] for row in timing.get('timings', []) if row['scenario'] == scenario}
    resource = load(run / (scenario + '-resources.json'), {})
    marks = '/'.join(str(fmt(lookup.get(k))) for k in ('heading-visible', 'add-enabled', 'switch-visible', 'switch-enabled'))
    history = [r for r in resource.get('resources', []) if re.search(r'/workspace/[^/]+/opencode/session$', r['name'])]
    settings = next((r for r in resource.get('resources', []) if r['name'].endswith('/sandbox-settings')), None)
    counts = resource.get('denCounts', {})
    paths = counts.get('byPath', {})
    windows = resource.get('notices', {})
    notices = '; '.join(f'{name} ' + ', '.join(f"{fmt(w['start'])}–{fmt(w['end'] if w['end'] is not None else w['last'])}{'+' if w['end'] is None else ''}" for w in entries) for name, entries in windows.items())
    unique = len({r['name'] for r in history})
    tti = fmt(lookup.get('tti'))
    if tti == 'NM' and 'tti' in lookup:
        tti = '>20,000 / not ready'
    return (tti, marks, counts.get('total', 'NM'), paths.get('/v1/me/desktop-config', 0), paths.get('/v1/org', 0), len(history), unique, fmt(settings['duration']) if settings else 'NM', notices)


def trace(path):
    data = load(path, {})
    rows = []
    marks = data.get('marks', {})
    tti = marks.get('tti')
    if not marks:
        timing = load(path.parent / 'timings.json', {})
        scenario = path.name.removesuffix('-resources.json')
        tti = next((row['ms'] for row in timing.get('timings', []) if row['scenario'] == scenario and row['metric'] == 'tti'), None)
    page_start = data['pageStart']
    for item in data.get('resources', []):
        endpoint = re.sub(r'^https?://[^/]+', '', item['name'])
        if item['startTime'] < page_start:
            continue
        timing = ', '.join(f"{phase['name']}={phase['duration']:.1f}" for phase in item.get('serverTiming', [])) or '—'
        rows.append((item['startTime'] - page_start, item['duration'], 'Renderer', endpoint, timing))
    epoch = data.get('pageEpoch')
    if epoch is not None:
        for item in data.get('den', []):
            start = datetime.fromisoformat(item['at'].replace('Z', '+00:00')).timestamp() * 1000 - epoch
            rows.append((start, item.get('durationMs'), 'Den proxy', f"{item['method']} {item['path']}", '—'))
    print('| Source | Request | Start (ms) | Duration (ms) | Server timing (ms) | Completion vs TTI |')
    print('|---|---|---:|---:|---|---|')
    for start, duration, layer, endpoint, timing in sorted(rows, key=lambda row: row[0]):
        completion = 'in flight at capture end' if duration is None else 'unknown' if tti is None else 'by TTI; not proof of blocking' if start + duration <= tti else 'after TTI; did not block'
        print(f'| {layer} | `{endpoint}` | {start:.1f} | {fmt(duration)} | {timing} | {completion} |')
    if epoch is None:
        print('\nLegacy capture had no synchronized Den clock; see the raw proxy log in the same JSON.')


def headlines(report):
    def summarize(phase, directory, scenario):
        samples = []
        for i in range(1, 4):
            file = report / phase / 'permissions' / f'{directory}-{i}' / f'{scenario}-resources.json'
            data = load(file, None)
            if data is not None:
                samples.append(data.get('marks', {}).get('tti'))
        values = [value for value in samples if value is not None]
        timeouts = len(samples) - len(values)
        if len(values) == 3:
            return f'{fmt(median(values))} ({fmt(min(values))}–{fmt(max(values))})'
        if not samples:
            return 'NM'
        detail = ', '.join(str(fmt(value)) for value in values)
        return f'{len(values)}/3 timed' + (f': {detail}' if detail else '') + (f'; {timeouts} not ready' if timeouts else '')

    print('| Scenario | Open | BEFORE median (range), ms | AFTER median (range), ms |')
    print('|---|---|---:|---:|')
    for n in (1, 12, 30):
        for run in ('cold', 'warm'):
            results = [summarize(phase, f'headline-in-n{n}', f'permissions-{run}') for phase in ('before', 'after')]
            print(f"| Signed in, {n} workspaces, +150 ms | {run} | {' | '.join(results)} |")
    for plan, scenario in [('on', 'permissions-cold'), ('slow', 'permissions-den-slow'), ('off', 'flag-off')]:
        results = [summarize(phase, f'signed-out-{plan}', scenario) for phase in ('before', 'after')]
        print(f"| Signed out, {plan} | cold | {' | '.join(results)} |")


if sys.argv[1] == '--trace':
    trace(Path(sys.argv[2]))
    sys.exit(0)
if sys.argv[1] == '--headline':
    headlines(Path(sys.argv[2]))
    sys.exit(0)

root = Path(sys.argv[1])
print('| State | Workspaces | Added Den latency | Cold TTI | Warm TTI | Direct TTI | Evidence |')
print('|---|---:|---:|---:|---:|---:|---|')
rows = []
for mode in ('in', 'out'):
    for n in (1, 12, 30):
        for ms in (0, 150, 400):
            name = f'signed-{mode}-n{n}'
            batched = root / name
            single = root / f'{name}-l{ms}'
            facts, evidence = [], []
            for phase in ('cold', 'warm', 'direct'):
                scenario = f'permissions-{phase}-l{ms}'
                run = batched
                if not (run / (scenario + '-resources.json')).exists():
                    run, scenario = single, f'permissions-{phase}'
                fact = detailed(run, scenario)
                facts.append(fact)
                if (run / (scenario + '-resources.json')).exists():
                    evidence.append(f'[{phase}]({run.name}/{scenario}-resources.json)')
                    rows.append((mode, n, ms, phase, fact))
            print(f"| {mode} | {n} | {ms} ms |", ' | '.join(str(f[0]) for f in facts), '|', ', '.join(evidence) or '—', '|')
print('\n**Per open.** Milestones are heading / Add folder enabled / switch visible / switch enabled (ms). Den counts are total / desktop-config / org over the full capture. History is `/opencode/session` requests / distinct workspaces. Switch GET is duration of `/sandbox-settings`. Visible notice intervals are in ms; `+` means still visible when polling ended.\n')
print('| State | N | Added ms | Open | Milestones | Den total / config / org | History | Switch GET | Notices |')
print('|---|---:|---:|---|---|---|---|---:|---|')
for mode, n, ms, phase, (_, marks, total, config, org, hist, unique, settings, notices) in rows:
    print(f'| {mode} | {n} | {ms} | {phase} | {marks} | {total}/{config}/{org} | {hist}/{unique} | {settings} | {notices or "—"} |')
