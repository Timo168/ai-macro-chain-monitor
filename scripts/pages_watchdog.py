"""Request a cloud check from the local scheduler when published checks have stalled."""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
from urllib.request import Request, urlopen

REPO = 'Timo168/ai-macro-chain-monitor'
BASE = 'https://timo168.github.io/ai-macro-chain-monitor/'
FRESH = timedelta(minutes=30)


def parse_time(value):
    if not isinstance(value, str):
        raise ValueError('missing completion time')
    stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('missing timezone')
    return stamp


def published_check(now):
    request = Request(BASE + 'data/manifest.json?watch=' + str(int(now.timestamp()) // 60),
                      headers={'Cache-Control': 'no-cache', 'User-Agent': 'AI-Macro-Observatory-Watchdog'})
    with urlopen(request, timeout=12) as response:
        manifest = json.loads(response.read(65536))
    return parse_time(manifest['macro']['lastCompletedAt'])


def gh_api(endpoint, *args):
    # Credentials stay managed by gh. Neither its prompts nor a console are shown.
    result = subprocess.run(['gh', 'api', 'repos/' + REPO + '/' + endpoint, *args],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=18,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                            env={**os.environ, 'GH_PROMPT_DISABLED': '1', 'GH_NO_UPDATE_NOTIFIER': '1'})
    if result.returncode:
        raise RuntimeError('GitHub CLI request failed (exit %d)' % result.returncode)
    return json.loads(result.stdout) if result.stdout.strip() else None


def cloud_busy(now):
    # Both workflows share the data-branch lock, including a queued source audit.
    for workflow in ('deploy.yml', 'audit-industry.yml'):
        runs = gh_api('actions/workflows/' + workflow + '/runs?branch=main&per_page=10')['workflow_runs']
        if any(run['status'] != 'completed' for run in runs):
            return True
        if workflow == 'deploy.yml' and any(now - parse_time(run['updated_at']) < FRESH for run in runs):
            return True
    return False


@contextmanager
def exclusive(path):
    # OS locks release on process exit, including after termination by Task Scheduler.
    with path.open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError):
            yield False
            return
        yield True


def check(folder: Path, now=None):
    now = now or datetime.now(timezone.utc)
    folder.mkdir(exist_ok=True, parents=True)
    path = folder / 'pages-watchdog.json'

    def save(status, failures, delay):
        state = {'checkedAt': now.isoformat(), 'status': status, 'consecutiveErrors': failures,
                 'nextAttemptAt': (now + timedelta(minutes=delay)).isoformat()}
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(state), encoding='utf-8')
        os.replace(tmp, path)

    with exclusive(folder / 'pages-watchdog.lock') as acquired:
        if not acquired:
            return 'already_checking'
        try:
            state = json.loads(path.read_text(encoding='utf-8'))
            failures = int(state['consecutiveErrors'])
            if now < parse_time(state['nextAttemptAt']):
                return 'cooldown'
        except (FileNotFoundError, ValueError, TypeError, KeyError):
            # An old or interrupted local record must not block future checks.
            failures = 0
        try:
            if now - published_check(now) < FRESH:
                save('published_recently', 0, 0)
                return 'published_recently'
            if cloud_busy(now):
                save('cloud_recent_or_active', 0, 0)
                return 'cloud_recent_or_active'
            # Protect against crashes or an HTTP timeout after GitHub accepts the dispatch.
            save('requesting', failures, 30)
            gh_api('actions/workflows/deploy.yml/dispatches', '--method', 'POST', '-f', 'ref=main')
        except (KeyError, TypeError, ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
            failures += 1
            save('check_failed', failures, min(120, 30 * 2 ** min(2, failures - 1)))
            return 'check_failed: ' + str(error)
        save('requested', 0, 30)
        return 'requested'
