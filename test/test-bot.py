#!/usr/bin/env python3
"""
test-bot.py — local tests for scripts/dashboard/bot.py

Starts bot.py with a mock Telegram token, intercepts all outbound TG calls
via a local mock server, then exercises every HTTP endpoint.

Run:
    python3 -m pytest scripts/onboard/test/test-bot.py -v
    # or
    python3 scripts/onboard/test/test-bot.py

No real Telegram token required. No network calls reach Telegram.
"""

import json
import os
import sys
import threading
import time
import urllib.request
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# ── paths ─────────────────────────────────────────────────────────────────────
ROOT    = Path(__file__).resolve().parents[3]          # repo root
BOT_PY  = ROOT / 'scripts' / 'dashboard' / 'bot.py'
BOT_PORT = 18889     # test port, avoids colliding with real bot on 8889
MOCK_TG_PORT = 19999 # fake telegram API

# ── Mock Telegram server ──────────────────────────────────────────────────────

class _TgCapture:
    """Records every TG API call bot.py makes."""
    def __init__(self):
        self.calls: list[dict] = []
        self.lock   = threading.Lock()

    def record(self, method: str, payload: dict):
        with self.lock:
            self.calls.append({'method': method, 'payload': payload})

    def clear(self):
        with self.lock:
            self.calls.clear()

    def of_type(self, method: str) -> list[dict]:
        with self.lock:
            return [c for c in self.calls if c['method'] == method]


_capture = _TgCapture()


class _MockTgHandler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def do_POST(self):
        # path = /botTOKEN/methodName
        method = self.path.rstrip('/').split('/')[-1]
        length = int(self.headers.get('Content-Length', 0))
        body   = json.loads(self.rfile.read(length)) if length else {}
        _capture.record(method, body)

        # return fake success response
        fake = {'ok': True, 'result': {'message_id': 42}}
        data = json.dumps(fake).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        # /botTOKEN/getUpdates → empty updates (polling response)
        if 'getUpdates' in self.path:
            data = json.dumps({'ok': True, 'result': []}).encode()
        elif 'v1/models' in self.path:
            # mock vLLM models list
            data = json.dumps({'data': [{'id': 'test-model'}]}).encode()
        else:
            data = json.dumps({'ok': True, 'result': {}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _start_mock_tg():
    srv = HTTPServer(('127.0.0.1', MOCK_TG_PORT), _MockTgHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


# ── Bot subprocess ─────────────────────────────────────────────────────────────

_bot_proc = None

def _start_bot():
    global _bot_proc
    env = {
        **os.environ,
        'NETDATA_TELEGRAM_BOT_TOKEN': 'test:MOCK_TOKEN',
        'NETDATA_TELEGRAM_CHAT_ID':   '123456789',
        'VIGYAN_BOT_PORT':            str(BOT_PORT),
        'VIGYAN_BOT_USERS':           '123456789:manish',
        # redirect TG API calls to our mock server
        'VIGYAN_TG_API_BASE':         f'http://127.0.0.1:{MOCK_TG_PORT}/bot',
        # redirect vLLM to mock server
        'VIGYAN_VLLM_HOST':           '127.0.0.1',
        'VIGYAN_VLLM_PORT':           str(MOCK_TG_PORT),
        'VIGYAN_AI_PC_HOST':          '127.0.0.1',
    }
    _bot_proc = subprocess.Popen(
        [sys.executable, str(BOT_PY)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    # wait up to 5s for bot to start
    for _ in range(25):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{BOT_PORT}/api/presence', timeout=1)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def _stop_bot():
    if _bot_proc:
        _bot_proc.terminate()
        try: _bot_proc.wait(timeout=3)
        except Exception: _bot_proc.kill()


# ── HTTP helper ───────────────────────────────────────────────────────────────

def _get(path: str) -> tuple[int, dict]:
    url = f'http://127.0.0.1:{BOT_PORT}{path}'
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _post(path: str, body: dict) -> tuple[int, dict]:
    url  = f'http://127.0.0.1:{BOT_PORT}{path}'
    data = json.dumps(body).encode()
    req  = urllib.request.Request(url, data=data,
                                  headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


# ── Test class (unittest-compatible, also works with pytest) ──────────────────

import unittest

class TestBotUnit(unittest.TestCase):
    """Unit tests — no server, import bot internals directly."""

    def setUp(self):
        # patch env before import
        os.environ.update({
            'NETDATA_TELEGRAM_BOT_TOKEN': 'unit:TEST',
            'NETDATA_TELEGRAM_CHAT_ID':   '111',
            'VIGYAN_BOT_USERS':           '111:manish,222:aryan',
        })
        # import bot module in isolated way
        import importlib.util, types
        spec = importlib.util.spec_from_file_location('bot_mod', str(BOT_PY))
        self.bot = importlib.util.module_from_spec(spec)
        # don't execute the if __name__ == '__main__' block
        sys.modules['bot_mod'] = self.bot
        spec.loader.exec_module(self.bot)

    # ── _parse_users ──────────────────────────────────────────────────────────

    def test_parse_users_basic(self):
        result = self.bot._parse_users('123456789:manish,987654321:aryan')
        self.assertEqual(result, {123456789: 'manish', 987654321: 'aryan'})

    def test_parse_users_empty(self):
        self.assertEqual(self.bot._parse_users(''), {})

    def test_parse_users_malformed_skipped(self):
        result = self.bot._parse_users('notanint:name,123:valid')
        self.assertIn(123, result)
        self.assertNotIn('notanint', result)

    # ── _vllm_summarise fallback ──────────────────────────────────────────────

    def test_vllm_fallback_on_unreachable(self):
        # vLLM unreachable → returns first non-empty line, max 120 chars
        raw = 'rsync finished 1234 files transferred successfully\nsome other line'
        result = self.bot._vllm_summarise(raw, context='rsync')
        self.assertIsInstance(result, str)
        self.assertGreater(len(result), 0)
        self.assertLessEqual(len(result), 120)

    def test_vllm_fallback_empty_raw(self):
        result = self.bot._vllm_summarise('', context='ctx')
        self.assertEqual(result, 'ctx')

    def test_vllm_fallback_whitespace_raw(self):
        result = self.bot._vllm_summarise('   \n  \n  ', context='fallback')
        self.assertEqual(result, 'fallback')

    # ── _active / _sess ───────────────────────────────────────────────────────

    def test_active_after_connect(self):
        self.bot._sess('testuser', 'connect')
        self.assertTrue(self.bot._active('testuser'))

    def test_inactive_after_disconnect(self):
        self.bot._sess('testuser', 'connect')
        self.bot._sess('testuser', 'disconnect')
        self.assertFalse(self.bot._active('testuser'))

    def test_inactive_unknown_user(self):
        self.assertFalse(self.bot._active('nobody'))

    def test_heartbeat_keeps_active(self):
        self.bot._sess('hbuser', 'connect')
        self.bot._sess('hbuser', 'heartbeat')
        self.assertTrue(self.bot._active('hbuser'))

    def test_job_add_remove(self):
        self.bot._sess('jobuser', 'connect')
        self.bot._sess('jobuser', 'job_add', job_id='j1', job_label='rsync photos')
        s = self.bot._sessions['jobuser']
        self.assertEqual(len(s['jobs']), 1)
        self.assertEqual(s['jobs'][0]['label'], 'rsync photos')
        self.bot._sess('jobuser', 'job_remove', job_id='j1')
        self.assertEqual(len(s['jobs']), 0)

    def test_job_no_duplicates(self):
        self.bot._sess('dupuser', 'connect')
        self.bot._sess('dupuser', 'job_add', job_id='j1', job_label='x')
        self.bot._sess('dupuser', 'job_add', job_id='j1', job_label='x')
        self.assertEqual(len(self.bot._sessions['dupuser']['jobs']), 1)

    # ── _confirm ──────────────────────────────────────────────────────────────

    def test_confirm_resolve_yes(self):
        # mock _tg so it doesn't actually call Telegram
        self.bot._tg = lambda *a, **kw: {}
        self.bot._send = lambda *a, **kw: 99
        self.bot._edit = lambda *a, **kw: None

        cid = self.bot._confirm_create('manish', 'Run dedup?', 'dedup', timeout=3600)
        self.assertIsInstance(cid, str)
        self.bot._confirm_resolve(cid, 'yes', via='test')
        c = self.bot._confirms[cid]
        self.assertTrue(c['resolved'])
        self.assertEqual(c['answer'], 'yes')

    def test_confirm_resolve_no(self):
        self.bot._tg  = lambda *a, **kw: {}
        self.bot._send = lambda *a, **kw: 99
        self.bot._edit = lambda *a, **kw: None

        cid = self.bot._confirm_create('manish', 'Delete dups?', 'dedup')
        self.bot._confirm_resolve(cid, 'no', via='test')
        self.assertEqual(self.bot._confirms[cid]['answer'], 'no')

    def test_confirm_double_resolve_ignored(self):
        self.bot._tg  = lambda *a, **kw: {}
        self.bot._send = lambda *a, **kw: 99
        self.bot._edit = lambda *a, **kw: None

        cid = self.bot._confirm_create('manish', 'Q?', 'a')
        self.bot._confirm_resolve(cid, 'yes', via='first')
        self.bot._confirm_resolve(cid, 'no',  via='second')  # must be ignored
        self.assertEqual(self.bot._confirms[cid]['answer'], 'yes')

    def test_confirm_expire(self):
        self.bot._tg  = lambda *a, **kw: {}
        self.bot._send = lambda *a, **kw: 99
        self.bot._edit = lambda *a, **kw: None

        cid = self.bot._confirm_create('manish', 'Q?', 'a', timeout=9999, default='skip')
        self.bot._confirm_expire(cid)
        self.assertEqual(self.bot._confirms[cid]['answer'], 'skip')

    # ── _log_event ────────────────────────────────────────────────────────────

    def test_log_event_stored(self):
        self.bot._log_event('manish', 'info', 'test summary')
        events = list(self.bot._event_log)
        last = events[-1]
        self.assertEqual(last['user'],    'manish')
        self.assertEqual(last['level'],   'info')
        self.assertEqual(last['summary'], 'test summary')
        self.assertIn('ts', last)

    def test_event_log_max_50(self):
        for i in range(60):
            self.bot._log_event('u', 'info', f'evt{i}')
        self.assertLessEqual(len(self.bot._event_log), 50)


class TestBotHTTP(unittest.TestCase):
    """Integration tests — starts bot.py subprocess, calls HTTP API."""

    @classmethod
    def setUpClass(cls):
        cls.mock_tg = _start_mock_tg()
        ok = _start_bot()
        if not ok:
            raise RuntimeError('bot.py failed to start — check env / port conflict')

    @classmethod
    def tearDownClass(cls):
        _stop_bot()
        cls.mock_tg.shutdown()

    def setUp(self):
        _capture.clear()

    # ── /api/presence ─────────────────────────────────────────────────────────

    def test_presence_empty(self):
        status, body = _get('/api/presence')
        self.assertEqual(status, 200)
        self.assertIsInstance(body, dict)

    # ── /api/session ──────────────────────────────────────────────────────────

    def test_session_connect(self):
        status, body = _post('/api/session', {'user': 'manish', 'action': 'connect'})
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])
        self.assertTrue(body['active'])

    def test_session_heartbeat(self):
        _post('/api/session', {'user': 'manish', 'action': 'connect'})
        status, body = _post('/api/session', {'user': 'manish', 'action': 'heartbeat'})
        self.assertEqual(status, 200)
        self.assertTrue(body['active'])

    def test_session_disconnect(self):
        _post('/api/session', {'user': 'manish', 'action': 'connect'})
        status, body = _post('/api/session', {'user': 'manish', 'action': 'disconnect'})
        self.assertEqual(status, 200)
        self.assertFalse(body['active'])

    def test_session_job_lifecycle(self):
        _post('/api/session', {'user': 'manish', 'action': 'connect'})
        _post('/api/session', {'user': 'manish', 'action': 'job_add',
                               'job_id': 'r1', 'job_label': 'rsync photos'})
        _, pres = _get('/api/presence')
        jobs = pres.get('manish', {}).get('jobs', [])
        self.assertTrue(any(j['id'] == 'r1' for j in jobs))

    # ── /api/notify ───────────────────────────────────────────────────────────

    def test_notify_client_present(self):
        # connect first so client is "present"
        _post('/api/session', {'user': 'manish', 'action': 'connect'})
        status, body = _post('/api/notify', {
            'user': 'manish', 'message': 'Photos synced OK', 'level': 'ok',
        })
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])
        # TG delivery is fire-and-forget; API must return 200 regardless

    def test_notify_with_job_id_removes_job(self):
        _post('/api/session', {'user': 'manish', 'action': 'connect'})
        _post('/api/session', {'user': 'manish', 'action': 'job_add',
                               'job_id': 'jdone', 'job_label': 'test'})
        _post('/api/notify', {'user': 'manish', 'message': 'done',
                               'level': 'ok', 'job_id': 'jdone'})
        _, pres = _get('/api/presence')
        jobs = pres.get('manish', {}).get('jobs', [])
        self.assertFalse(any(j['id'] == 'jdone' for j in jobs))

    def test_notify_disconnected_raw_triggers_async(self):
        # disconnect the client first
        _post('/api/session', {'user': 'manish', 'action': 'disconnect'})
        status, body = _post('/api/notify', {
            'user':    'manish',
            'level':   'info',
            'message': 'rsync output',
            'raw':     'Transferred 1234 files, 0 errors.',
        })
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])

    # ── /api/confirm ──────────────────────────────────────────────────────────

    def test_confirm_creates_and_returns_id(self):
        status, body = _post('/api/confirm', {
            'user':     'manish',
            'question': 'Run dedup?',
            'action':   'dedup',
        })
        self.assertEqual(status, 200)
        self.assertIn('confirm_id', body)
        self.assertIsInstance(body['confirm_id'], str)
        self.assertGreater(len(body['confirm_id']), 0)

    def test_confirm_respond_yes(self):
        _, c = _post('/api/confirm', {'user': 'manish', 'question': 'Q?', 'action': 'x'})
        cid = c['confirm_id']
        status, body = _post('/api/confirm/respond', {'confirm_id': cid, 'answer': 'yes'})
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])

    def test_confirm_respond_no(self):
        _, c = _post('/api/confirm', {'user': 'manish', 'question': 'Q?', 'action': 'x'})
        status, body = _post('/api/confirm/respond',
                             {'confirm_id': c['confirm_id'], 'answer': 'no'})
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])

    # ── /api/handoff ──────────────────────────────────────────────────────────

    def test_handoff_sends_tg_message(self):
        _post('/api/session', {'user': 'manish', 'action': 'connect'})
        status, body = _post('/api/handoff', {
            'user':       'manish',
            'job_label':  'Photo import',
            'next_steps': [{'label': 'Tag faces', 'action': 'face-tag'},
                           {'label': 'Run ESRGAN', 'action': 'esrgan'}],
        })
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])

    # ── /api/onboard/survey-ready ─────────────────────────────────────────────

    def test_survey_ready_notifies_admin(self):
        status, body = _post('/api/onboard/survey-ready', {'user': 'aryan'})
        self.assertEqual(status, 200)
        self.assertTrue(body['ok'])

    # ── /api/summary ─────────────────────────────────────────────────────────

    def test_summary_shape(self):
        status, body = _get('/api/summary')
        self.assertEqual(status, 200)
        self.assertIn('health', body)
        self.assertIn('events', body)
        self.assertIn('presence', body)
        self.assertIsInstance(body['events'], list)

    # ── 404 ──────────────────────────────────────────────────────────────────

    def test_unknown_route(self):
        status, body = _get('/api/nonexistent')
        self.assertEqual(status, 404)
        self.assertIn('error', body)

    # ── CORS preflight ────────────────────────────────────────────────────────

    def test_options_cors(self):
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', BOT_PORT)
        conn.request('OPTIONS', '/api/notify')
        r = conn.getresponse()
        self.assertEqual(r.status, 204)
        headers = dict(r.getheaders())
        self.assertIn('Access-Control-Allow-Origin',
                      {k for k in headers})


# ── Standalone runner ─────────────────────────────────────────────────────────

if __name__ == '__main__':
    unittest.main(verbosity=2)
