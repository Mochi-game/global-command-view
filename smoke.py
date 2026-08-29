"""Smoke test for Global Command View.

Five times in one day a change went out that stopped the app booting, and every
one was found by noticing a version chip reading "v-" rather than by anything
checking. They were all the same shape: a name referenced before it existed,
after it stopped existing, or spelled differently in two files.

That shape is cheap to catch mechanically, so this does three things:

  1. Reads app.js and index.html and checks the names line up - every `$('#id')`
     has an element, every bare callback handed to addEventListener is defined,
     every layer id asked of applyVisibility is in LAYERS.
  2. Starts the server on its own port and calls every API endpoint it can find
     in server.py, checking each answers and parses.
  3. Prints what broke, and exits non-zero so it can gate anything.

Run it:      python smoke.py
Faster:      python smoke.py --quick     (skips the slow feeds)
Keep alive:  python smoke.py --port 8899

Stdlib only, like the rest of this.
"""

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")

# Endpoints that need arguments, and something sensible to give them. Anything
# discovered in server.py that is not listed here is called bare.
ENDPOINT_ARGS = {
    "fires": "bbox=10,55,25,62",
    "vessels": "bbox=17,58,21,61",
    "openwaters": "south=58&west=16&north=61&east=21",
    "cameras-nearby": "lat=59.33&lon=18.06",
    "streetview": "lat=59.33&lon=18.06",
    "imagery-date": "lat=59.33&lon=18.06",
    "aircraft": "hex=4ca7b5&callsign=SAS123",
    "vessel-photo": "name=Silja%20Serenade",
    "ship": "title=Silja%20Serenade",
    "satellite": "norad=25544&name=ISS%20(ZARYA)",
    "place": "lat=59.33&lon=18.06",
    "buildings": "lat=59.33&lon=18.06",
    "flights": "lamin=55&lomin=10&lamax=62&lomax=25",
    "powerplants": "bbox=10,55,25,70",
    "headofstate": "country=Sweden",
    "recon": "kind=dns&target=svt.se",
    "mesh": "bbox=10,55,25,70",
    "geocode": "q=Uppsala%2C%20Sweden",
    "aprs": "bbox=5,54,30,70",
    "entity": "q=Ryanair",
    "airports": "bbox=10,55,25,70",
    "broadcast": "lat=27.99&lon=-81.76&radius=200",
}

# Endpoints that fetch something large or paced, and are skipped by --quick.
SLOW = {"fires", "briefing", "outbreaks", "satellites", "cables", "landings",
        "cameras", "buildings", "streetview", "place", "satellite",
        "powerplants", "kiwisdr", "headofstate", "netoutages",
        "recon", "weather", "mesh", "newsheat", "trains",
        "geocode", "aprs", "entity", "airports", "broadcast"}

# Endpoints allowed to answer 400 when called without usable arguments.
MAY_REFUSE = {"buildings", "flights"}


class Report:
    def __init__(self):
        self.failures = []
        self.notes = []

    def fail(self, area, detail):
        self.failures.append((area, detail))

    def note(self, text):
        self.notes.append(text)

    def ok(self):
        return not self.failures


# --------------------------------------------------------------- static checks

def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def check_ids(app_js, index_html, report):
    """Every $('#thing') in the script should exist in the page.

    This is the check that would have caught the outbreaks layer: a selector
    reaching for something the markup never got.
    """
    have = set(re.findall(r'id="([A-Za-z0-9_-]+)"', index_html))
    want = set(re.findall(r"""\$\(['"]#([A-Za-z0-9_-]+)['"]\)""", app_js))
    missing = sorted(want - have)
    for name in missing:
        report.fail("markup", "$('#%s') has no element in index.html" % name)
    report.note("%d selectors checked against %d elements" % (len(want), len(have)))


def check_callbacks(app_js, report):
    """A bare name handed to addEventListener has to be a name that exists.

    `moveEnd.addEventListener(updateTraffic)` outlived the function it named and
    threw during module evaluation, which stops everything after it.
    """
    declared = set(re.findall(
        r"(?:function|const|let|var|async function)\s+([A-Za-z_$][\w$]*)", app_js))
    declared |= set(re.findall(r"([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(", app_js))
    used = set(re.findall(r"addEventListener\(\s*([A-Za-z_$][\w$]*)\s*\)", app_js))
    used |= set(re.findall(
        r"addEventListener\(\s*['\"][\w-]+['\"]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]", app_js))
    unknown = sorted(n for n in used - declared if n not in ("function", "async"))
    for name in unknown:
        report.fail("callbacks", "addEventListener(%s) - %s is never declared" % (name, name))
    report.note("%d event callbacks resolved" % len(used))


def check_layers(app_js, report):
    """Every id asked of the layer table has to be in the layer table.

    applyVisibility does LAYERS.find(...).on, so a missing id is a TypeError at
    startup rather than a layer that quietly does nothing.
    """
    ids = set(re.findall(r"\{\s*id:\s*'([a-z]+)'", app_js))
    asked = set(re.findall(r"\bon\('([a-z]+)'\)", app_js))
    missing = sorted(asked - ids)
    for name in missing:
        report.fail("layers", "on('%s') but no LAYERS entry has that id" % name)
    report.note("%d layer ids, %d lookups" % (len(ids), len(asked)))


def check_grouped(app_js, report):
    """A layer that belongs to no group.

    The panel falls back to an "Other" bucket at the very bottom, so nothing
    disappears - it just lands where nobody looks. Two layers sat there for a
    day because a replacement that was meant to add them to a group silently
    matched nothing, which is exactly the kind of miss a test should catch and
    reading a diff will not.
    """
    ids = re.findall(r"\{ id: '([a-z]+)', name:", app_js)
    grouped = set()
    for chunk in re.findall(r"ids: \[([^\]]+)\]", app_js):
        grouped.update(re.findall(r"'([a-z]+)'", chunk))
    orphans = [i for i in ids if i not in grouped]
    if orphans:
        report.fail("layers", "in no group, so they land under Other: %s"
                    % ", ".join(orphans))
    else:
        report.note("layer groups: every layer belongs to one")


def check_keys_documented(app_js, report):
    """A key the server accepts that nobody is told how to get.

    Four times now a second copy of a list has drifted from the first: the keys
    endpoint kept its own hardcoded names, the layer groups missed two layers,
    the help text fell behind, and the README key table went a release without
    the newest key in it. The lists are not going away, so the drift is checked
    instead of trusted.
    """
    server = read(os.path.join(ROOT, "server.py"))
    found = re.search(r"ALLOWED_KEYS = \((.*?)\)", server, re.S)
    if not found:
        report.fail("keys", "ALLOWED_KEYS not found in server.py")
        return
    declared = re.findall(r'"([a-z_]+)"', found.group(1))

    readme = read(os.path.join(ROOT, "README.md"))
    missing = []
    for key in declared:
        if "`%s`" % key not in readme:
            missing.append("%s (README)" % key)
        if "'%s'" % key not in app_js:
            missing.append("%s (Setup)" % key)
    if missing:
        report.fail("keys", "accepted by the server but undocumented: %s"
                    % ", ".join(missing))
    else:
        report.note("keys: all %d have a README row and a Setup field"
                    % len(declared))


def check_badges(app_js, report):
    """A source row whose licence badge has nothing to say.

    The badge was widened from two states to three, and doing that quietly
    relabelled seven rows to a fallback because their value was not in the new
    map: NON-COMM became CHECK IT on sources whose terms had not changed. A
    licence badge that drifts is worse than no badge, because somebody reads it
    before deciding what they are allowed to sell.
    """
    start = app_js.find("const SOURCE_LICENCES")
    if start == -1:
        report.fail("sources", "SOURCE_LICENCES not found")
        return
    block = app_js[start:app_js.index("\n];", start)]

    used = set()
    for line in block.split("\n"):
        line = line.strip()
        if not line.startswith("['"):
            continue
        quoted = re.findall(r"'([^']*)'", line)
        if len(quoted) >= 4:
            used.add(quoted[-1])

    at = app_js.find("const BADGE = {")
    if at == -1:
        report.fail("sources", "BADGE map not found")
        return
    badge = app_js[at:app_js.index("};", at)]
    known = set(re.findall(r"^\s*'?([a-z -]+?)'?:", badge, re.M))

    orphan = sorted(u for u in used if u not in known)
    if orphan:
        report.fail("sources", "licence values with no badge, so they fall back: %s"
                    % ", ".join(orphan))
    else:
        report.note("source badges: all %d licence values have one" % len(used))



# Failures that are this machine's, not the service's.
#
# A fresh install on a second computer reported three registration links as not
# answering and one feed as HTTP 502, and every one of them carried
# CERTIFICATE_VERIFY_FAILED. Nothing was wrong with Trafikverket, OpenSky,
# TomTom or Wikipedia. Python could not verify a certificate, and the report
# named the services instead of saying so - which sent the reader looking for a
# key they had not set, in an app that never calls a keyed service without one.
#
# Blaming the wrong party is worse than saying nothing, so these are recognised
# and reported once, as what they are.
TLS_MARKERS = (
    "CERTIFICATE_VERIFY_FAILED",
    "SSL: CERTIFICA",
    "certificate verify failed",
    "SSLCertVerificationError",
    "unable to get local issuer",
)

LOCAL_MARKERS = TLS_MARKERS + (
    "getaddrinfo failed",
    "Name or service not known",
    "Temporary failure in name resolution",
)


def local_fault(text):
    """Is this failure the machine's own, rather than the other end's?"""
    return any(m.lower() in str(text).lower() for m in LOCAL_MARKERS)


def tls_advice(count, where):
    """One explanation, in place of a list of accusations."""
    return (
        "%d %s failed because this machine cannot verify HTTPS certificates, "
        "not because anything is down. Python on Windows uses the Windows "
        "certificate store, and Windows fetches root certificates the first "
        "time something needs them - on a new machine, or one that cannot "
        "reach Windows Update, they are simply not there yet. Opening one of "
        "the failing addresses in Edge once is usually enough: the browser "
        "makes Windows fetch the root, and Python then finds it. If the "
        "machine is behind antivirus or a company proxy that inspects HTTPS, "
        "that product's own certificate has to be trusted by Windows instead. "
        "No key is involved - this app never calls a service that needs a key "
        "until you have entered one."
        % (count, where)
    )


def check_setup_links(app_js, report):
    """A GET THE KEY button that leads to a 404.

    Two of the ten did. Both had been right when they were written and quietly
    stopped being: openaq.org/developers went away, and the Trafikverket API
    root stopped answering at all. Nothing in the app could tell, because a dead
    link looks exactly like a live one until somebody clicks it - and the person
    who clicks it is somebody deciding whether this app is worth the trouble.

    Networked, so it is skipped by --quick along with the slow feeds.
    """
    start = app_js.find("const SERVICES")
    if start == -1:
        report.fail("setup", "SERVICES not found")
        return
    block = app_js[start:app_js.index("\n];", start)]
    pairs = re.findall(r"name: '([^']+)',(?:.|\n)*?url: '([^']+)'", block)
    if not pairs:
        report.fail("setup", "no service links found to check")
        return

    dead = []
    local = []
    for name, url in pairs:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                if resp.status >= 400:
                    dead.append("%s %s (%s)" % (name, url, resp.status))
        except urllib.error.HTTPError as exc:
            dead.append("%s %s (%s)" % (name, url, exc.code))
        except Exception as exc:  # noqa: BLE001 - a link check, not a feed
            # A certificate this machine cannot verify says nothing about the
            # link. Reported separately, or the reader goes looking for a fault
            # at Trafikverket that is sitting on their own computer.
            if local_fault(exc):
                local.append(name)
            else:
                dead.append("%s %s (%s)" % (name, url, str(exc)[:30]))

    if local:
        report.fail("setup", tls_advice(len(local), "registration links (%s)"
                                        % ", ".join(local)))
    if dead:
        report.fail("setup", "GET THE KEY links that do not answer: %s"
                    % "; ".join(dead))
    if not dead and not local:
        report.note("setup links: all %d answer" % len(pairs))


def check_cache(report):
    """The disk cache inside the ceilings it claims to keep.

    It ran unbounded for months and reached 92 MB in 34 000 files. A budget that
    nothing verifies is a comment, so this reads the real directory and compares
    it against the constants the server enforces.
    """
    import re as _re
    src = read(os.path.join(ROOT, "server.py"))
    def const(name, fallback):
        m = _re.search(r"^%s = (.+)$" % name, src, _re.M)
        if not m:
            return fallback
        try:
            return eval(m.group(1).split("#")[0].strip(), {})  # noqa: S307
        except Exception:  # noqa: BLE001
            return fallback
    budget = const("DISK_BUDGET_BYTES", 0)
    max_files = const("DISK_MAX_FILES", 0)
    cache = os.path.join(ROOT, ".cache")
    if not budget or not max_files:
        report.fail("cache", "no disk budget defined in server.py")
        return
    if not os.path.isdir(cache):
        report.note("disk cache: nothing written yet")
        return
    total = count = 0
    for name in os.listdir(cache):
        path = os.path.join(cache, name)
        if os.path.isfile(path):
            total += os.path.getsize(path)
            count += 1
    over = []
    if total > budget:
        over.append("%.0f MB against a %.0f MB budget" % (total / 1e6, budget / 1e6))
    if count > max_files:
        over.append("%d files against a %d ceiling" % (count, max_files))
    if over:
        report.fail("cache", "; ".join(over))
    else:
        report.note("disk cache: %.1f MB in %d files, inside %.0f MB / %d"
                    % (total / 1e6, count, budget / 1e6, max_files))


def check_commas(app_js, report):
    """A value followed by the next key with no comma between them.

    `note: 'x' noCount: true` is a syntax error, the app does not boot, and the
    version chip reads v-. It is invisible to brace counting, because the braces
    still balance, and it reads as ordinary code in a diff. Twice now a patch
    script has spliced a field into an object literal and forgotten the comma.

    The pattern is narrow on purpose: a closing quote, digit or boolean, then
    whitespace, then an identifier and a colon. A ternary puts the colon straight
    after the value with no identifier between, so it does not match.
    """
    bad = []
    pattern = re.compile(r"""(['"]|\d|\btrue\b|\bfalse\b)[ \t]+([A-Za-z_$][\w$]*)\s*:""")
    for line_no, line in enumerate(app_js.split("\n"), 1):
        stripped = line.strip()
        if stripped.startswith("//") or stripped.startswith("*"):
            continue
        for m in pattern.finditer(line):
            bad.append("app.js:%d missing comma before %s:" % (line_no, m.group(2)))
    if bad:
        for one in bad[:8]:
            report.fail("syntax", one)
    else:
        report.note("object literals: no field left without its comma")



def check_trust_script(report):
    """The unblock step, still wired into the installer.

    Everything unpacked from a downloaded ZIP carries Windows' Mark of the Web,
    which raises SmartScreen on the launchers and stops stop.ps1 running at all.
    The installer clears it before doing anything else, and that is one line in
    a batch file - exactly the kind of thing that gets lost in an edit and is
    never noticed, because the person it breaks is a stranger on their first run
    and the machine it was tested on was trusted already.

    The guard is checked too. The script refuses to run unless server.py is
    beside it, which is what stops it being copied into a download folder and
    used to wave through a pile of things nobody looked at.
    """
    script = os.path.join(ROOT, "Trust these files.ps1")
    if not os.path.exists(script):
        report.fail("trust", "Trust these files.ps1 is missing")
        return

    with open(script, encoding="utf-8", errors="replace") as fh:
        body = fh.read()
    if "Unblock-File" not in body:
        report.fail("trust", "the script no longer calls Unblock-File")
    if "server.py" not in body:
        report.fail("trust", "the guard on server.py is gone - it would run anywhere")

    installer = os.path.join(ROOT, "Install Global Command View.cmd")
    if not os.path.exists(installer):
        report.fail("trust", "Install Global Command View.cmd is missing")
        return
    with open(installer, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    # The whole invocation, not the filename. A bare substring check passes on
    # anything containing the name - it was written that way first and a test
    # that renamed the script to .DISABLED still came back all clear, which is
    # a check that cannot fail and therefore is not one.
    wanted = 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Trust these files.ps1"'
    if wanted not in text:
        report.fail("trust", "the installer no longer runs the unblock step")



def check_start_hidden(report):
    """The launcher still starts the server without a window.

    Three pieces have to stay joined: the .cmd somebody double-clicks, the
    PowerShell beside it, and the -WindowStyle Hidden that is the whole point.
    Lose the last one and everything still works - which is why it needs a test.
    A console window that came back would be a regression nobody notices until
    somebody complains about a black box on their taskbar again.

    The whole invocation is matched rather than the filename, because a check
    that looks for a substring passes on a file renamed to .DISABLED.
    """
    launcher = os.path.join(ROOT, "Start Global Command View.cmd")
    script = os.path.join(ROOT, "start.ps1")

    if not os.path.exists(script):
        report.fail("start", "start.ps1 is missing")
        return
    if not os.path.exists(launcher):
        report.fail("start", "Start Global Command View.cmd is missing")
        return

    with open(launcher, encoding="utf-8", errors="replace") as fh:
        wanted = 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"'
        if wanted not in fh.read():
            report.fail("start", "the launcher no longer runs start.ps1")

    with open(script, encoding="utf-8", errors="replace") as fh:
        body = fh.read()
    if "-WindowStyle Hidden" not in body:
        report.fail("start", "the server would start with a visible window again")
    # The health check is what stops the launcher walking away from a server
    # that died on startup, leaving no window, no browser and nothing to read.
    if "api/version" not in body:
        report.fail("start", "the launcher no longer waits for the server to answer")



def check_cert_warmup(report):
    """The certificate warm-up, still reachable from both places that call it.

    This is the fix for a fresh Windows machine where Python cannot verify hosts
    the rest of the computer reaches fine, and it works by being run - so the two
    call sites matter as much as the script. The installer waits for it; the
    launcher fires it in the background for somebody who never ran the installer.
    Lose either line and the app still works perfectly on every machine that did
    not need it, which is exactly why nobody would notice.
    """
    warm = os.path.join(ROOT, "warm-certificates.ps1")
    if not os.path.exists(warm):
        report.fail("certificates", "warm-certificates.ps1 is missing")
        return
    with open(warm, encoding="utf-8", errors="replace") as fh:
        body = fh.read()
    if "AuthenticateAsClient" not in body:
        report.fail("certificates", "the handshake is gone, so no root is ever fetched")
    if "RunspaceFactory" not in body:
        report.fail("certificates",
                    "the parallel pool is gone - sequentially this took 27s, not 5s")

    for name, want in (
        ("Install Global Command View.cmd",
         'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0warm-certificates.ps1"'),
        ("start.ps1", "warm-certificates.ps1"),
    ):
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            report.fail("certificates", "%s is missing" % name)
            continue
        with open(path, encoding="utf-8", errors="replace") as fh:
            if want not in fh.read():
                report.fail("certificates", "%s no longer runs the warm-up" % name)



def check_ca_fallback(report):
    """The certificate bundle, and the fact that it is only a fallback.

    Two things can go wrong here and only one of them is visible. The bundle can
    go missing, which breaks machines that need it - noticeable. Or the order can
    invert so every request verifies against a file that ages instead of the
    operating system's current store, which breaks nothing today and quietly
    stops trusting a new authority in a year.

    So both are checked: that the file is there with a plausible number of roots,
    and that the system path is still tried first.
    """
    bundle = os.path.join(ROOT, "certs", "cacert.pem")
    if not os.path.exists(bundle):
        report.fail("certificates", "certs/cacert.pem is missing")
        return
    with open(bundle, encoding="utf-8", errors="replace") as fh:
        roots = fh.read().count("BEGIN CERTIFICATE")
    if roots < 50:
        report.fail("certificates", "the bundle holds only %d roots" % roots)

    src = read(os.path.join(ROOT, "server.py"))
    if "_urlopen_with_fallback" not in src:
        report.fail("certificates", "the fallback is no longer installed")
        return
    body = src[src.index("def _urlopen_with_fallback"):]
    body = body[:body.index(chr(10) + "urllib.request.urlopen =")]
    if "_system_urlopen" not in body.split("except")[0]:
        report.fail("certificates",
                    "the bundle is tried before the system store, not after")
    if "_is_cert_error" not in body:
        report.fail("certificates",
                    "every failure now retries against the bundle, not just certificate ones")


def check_placeholders(app_js, report):
    """A template hole naming something JavaScript has never heard of.

    Three times now a patch script has left one of its own variables behind
    inside a template string - `${DOT}` where a middle dot was meant. Each is a
    ReferenceError the moment that line runs, which can be days later down a
    branch nobody took while testing, and it looks like ordinary prose in a diff.

    Mechanically obvious, though: a hole containing a single SHOUTING_NAME that
    is declared nowhere in the file. Real ones - `${data.as_of}`, `${MAX}` where
    MAX exists - are left alone.
    """
    declared = set(re.findall(
        r"(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]*)\b", app_js))
    found = 0
    for line_no, line in enumerate(app_js.split("\n"), 1):
        for hole in re.findall(r"\$\{\s*([A-Z][A-Z0-9_]+)\s*\}", line):
            if hole not in declared:
                found += 1
                report.fail("template", "app.js:%d ${%s} is declared nowhere"
                            % (line_no, hole))
    if not found:
        report.note("template holes: none naming an undeclared identifier")


def check_strings(app_js, report):
    """A quote that opens and never closes on the same line.

    `'the station\'s own stream'` written without the backslash ends the string
    early, and everything after it is a syntax error - the app does not boot and
    the version chip reads v-. Balance counting cannot see it, because the quotes
    still balance.

    The state has to carry across lines or prose is mistaken for code: a block
    comment saying "the station's own stream" is fine, and so is a template
    literal spanning several lines. Only a plain quote left open at a line end,
    outside both, is the mistake - this codebase concatenates with `+` rather
    than continuing strings across lines.
    """
    in_block = False        # inside /* ... */
    in_template = False     # inside a backtick literal
    problems = 0

    for number, line in enumerate(app_js.split("\n"), 1):
        i = 0
        quote = None
        opened = 0
        while i < len(line):
            ch = line[i]

            if in_block:
                end = line.find("*/", i)
                if end == -1:
                    i = len(line)
                else:
                    in_block = False
                    i = end + 2
                continue

            if in_template:
                if ch == "\\":
                    i += 2
                    continue
                if ch == "`":
                    in_template = False
                i += 1
                continue

            if quote:
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    quote = None
                i += 1
                continue

            if ch == "`":
                in_template = True
            elif ch in "'\"":
                quote, opened = ch, i
            elif ch == "/" and i + 1 < len(line):
                if line[i + 1] == "/":
                    break
                if line[i + 1] == "*":
                    in_block = True
                    i += 2
                    continue
            i += 1

        if quote:
            problems += 1
            report.fail(
                "strings",
                "line %d: %s opened at column %d and never closed - "
                "an unescaped apostrophe?" % (number, quote, opened + 1),
            )

    if not problems:
        report.note("string literals close on the line they open")


def check_balance(app_js, report):
    """Braces and brackets, which a generated patch can unbalance silently."""
    for opener, closer, name in (("{", "}", "braces"), ("(", ")", "parens"),
                                 ("[", "]", "brackets")):
        drift = app_js.count(opener) - app_js.count(closer)
        if drift:
            report.fail("syntax", "%s unbalanced by %+d in app.js" % (name, drift))


def check_python(report):
    """server.py has to parse, which is cheap to be certain of."""
    import ast
    for name in ("server.py", "aisstream.py"):
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            continue
        try:
            ast.parse(read(path))
        except SyntaxError as exc:
            report.fail("syntax", "%s does not parse: %s" % (name, exc))


# ---------------------------------------------------------------- server check

def find_endpoints(server_py):
    names = re.findall(r'elif name == "([a-z-]+)"', server_py)
    names += re.findall(r'if name == "([a-z-]+)"', server_py)
    names += re.findall(r'elif name in \(([^)]+)\)', server_py)
    flat = []
    for item in names:
        if '"' in item:
            flat.extend(re.findall(r'"([a-z-]+)"', item))
        else:
            flat.append(item)
    return sorted(set(flat))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(port, seconds=25):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.4)
    return False


def call(port, path, timeout=90):
    url = "http://127.0.0.1:%d%s" % (port, path)
    started = time.time()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read()
        return resp.status, body, time.time() - started
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), time.time() - started
    except Exception as exc:  # noqa: BLE001
        return 0, str(exc).encode(), time.time() - started



def check_openwaters_licence(port, report):
    """The one filter in this app where a silent mistake has consequences.

    openwaters.io re-serves several AIS networks and their licences are not
    pooled: Kystverket is NLOD, Fintraffic is CC BY, AISHub grants use only, and
    volunteer receivers are still settling theirs. Commercial-safe mode exists to
    keep somebody with a monetised channel out of trouble, so a vessel wrongly
    marked open is not a broken feature - it is a quiet wrong answer in the one
    place that must not give one.

    Two things are checked. That the rule is an allowlist, because volunteers
    arrive under their own station hash - source "v1:ed25519:GzNIQN..." - and a
    list of names to exclude would admit every new one that appeared. And that
    the flag actually follows it, against the live feed rather than a fixture:
    every vessel marked open must come from a named clean source, and every one
    from those sources must be marked open.

    Networked, so --quick skips it with the other live checks.
    """
    src = read(os.path.join(ROOT, "server.py"))
    if "OPENWATERS_OPEN = {" not in src:
        report.fail("openwaters", "the licence allowlist is gone")
        return
    block = src[src.index("OPENWATERS_OPEN = {"):]
    block = block[:block.index("}")]
    named = set(re.findall(r'"([a-z]+)":', block))
    if not named:
        report.fail("openwaters", "the allowlist names no sources, so nothing is clean")
        return
    if "aishub" in named or "aisstream" in named:
        report.fail("openwaters",
                    "a use-only source is on the clean list: %s" % sorted(named))

    status, body, _ = call(port, "/api/openwaters"
                           "?south=58&west=4&north=64&east=12")
    if status != 200:
        report.note("openwaters: no live answer to check the flag against (HTTP %s)" % status)
        return
    try:
        data = json.loads(body)
    except Exception as exc:  # noqa: BLE001
        report.fail("openwaters", "answered but not JSON: %s" % exc)
        return
    ships = data.get("vessels") or []
    if not ships:
        report.note("openwaters: answered with no vessels, flag not exercised")
        return

    wrong_open = sorted({v.get("source") for v in ships
                         if v.get("open") and v.get("source") not in named})
    wrong_shut = sorted({v.get("source") for v in ships
                         if not v.get("open") and v.get("source") in named})
    if wrong_open:
        report.fail("openwaters",
                    "marked open but not on the allowlist: %s" % wrong_open)
    if wrong_shut:
        report.fail("openwaters",
                    "on the allowlist but marked not open: %s" % wrong_shut)
    if not wrong_open and not wrong_shut:
        report.note("openwaters: %d vessels, %d open, allowlist holds"
                    % (len(ships), data.get("open_count", 0)))


def check_server(port, quick, report):
    server_py = read(os.path.join(ROOT, "server.py"))
    endpoints = find_endpoints(server_py)
    report.note("%d endpoints found in server.py" % len(endpoints))

    tls_hits = []

    for name in endpoints:
        if quick and name in SLOW:
            print("  %-16s skipped (--quick)" % name)
            continue
        args = ENDPOINT_ARGS.get(name, "")
        path = "/api/" + name + (("?" + args) if args else "")
        status, body, took = call(port, path)

        if status == 0:
            report.fail("api/" + name, "no answer: %s" % body.decode()[:90])
            print("  %-16s FAILED   %s" % (name, body.decode()[:60]))
            continue
        if status == 400 and name in MAY_REFUSE:
            print("  %-16s 400 ok   refuses without usable arguments" % name)
            continue
        if status != 200:
            detail = body[:200].decode("utf-8", "replace")
            if local_fault(detail):
                # The feed is fine; this machine could not complete the
                # handshake. Counted, and explained once at the end.
                tls_hits.append(name)
                print("  %-16s HTTP %d   certificate not verified here" % (name, status))
                continue
            report.fail("api/" + name, "HTTP %d: %s" % (status, detail[:90]))
            print("  %-16s HTTP %d" % (name, status))
            continue
        try:
            parsed = json.loads(body)
        except Exception as exc:  # noqa: BLE001
            report.fail("api/" + name, "answered 200 but not JSON: %s" % exc)
            print("  %-16s BAD JSON" % name)
            continue
        size = len(body)
        shape = ("%d keys" % len(parsed)) if isinstance(parsed, dict) else \
                ("%d items" % len(parsed)) if isinstance(parsed, list) else "scalar"
        print("  %-16s 200      %6.2fs  %7d B  %s" % (name, took, size, shape))

    if tls_hits:
        report.fail("certificates", tls_advice(len(tls_hits), "feeds (%s)"
                                               % ", ".join(sorted(tls_hits))))

    # The version endpoint is the app's own statement that it started.
    status, body, _ = call(port, "/api/version")
    if status == 200:
        version = json.loads(body).get("version")
        report.note("server reports v%s" % version)
    else:
        report.fail("api/version", "the server cannot say what it is")


# ------------------------------------------------------------------------ main


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--quick", action="store_true",
                        help="skip the endpoints that fetch large or paced feeds")
    parser.add_argument("--port", type=int, default=0,
                        help="test against an already running server on this port")
    args = parser.parse_args()

    report = Report()

    print("static checks")
    app_js = read(os.path.join(WEB, "app.js"))
    index_html = read(os.path.join(WEB, "index.html"))
    check_balance(app_js, report)
    check_strings(app_js, report)
    check_placeholders(app_js, report)
    check_grouped(app_js, report)
    check_keys_documented(app_js, report)
    check_badges(app_js, report)
    check_trust_script(report)
    check_start_hidden(report)
    check_cert_warmup(report)
    check_ca_fallback(report)
    if not args.quick:
        check_setup_links(app_js, report)
    check_commas(app_js, report)
    check_cache(report)
    check_ids(app_js, index_html, report)
    check_callbacks(app_js, report)
    check_layers(app_js, report)
    check_python(report)
    for note in report.notes:
        print("  " + note)

    started = None
    port = args.port
    if not port:
        port = free_port()
        print("\nstarting a server on %d" % port)
        started = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "server.py"),
             "--port", str(port), "--no-open"],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if not wait_for(port):
            report.fail("server", "did not begin listening on %d" % port)
            started.kill()
            started = None
    else:
        print("\nusing the server already on %d" % port)

    if port and (started or args.port):
        print("\nendpoints")
        try:
            check_server(port, args.quick, report)
            if not args.quick:
                check_openwaters_licence(port, report)
        finally:
            if started:
                started.terminate()
                try:
                    started.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    started.kill()

    print("\n" + "-" * 62)
    if report.ok():
        print("all clear")
        return 0
    print("%d problem%s" % (len(report.failures),
                            "" if len(report.failures) == 1 else "s"))
    for area, detail in report.failures:
        print("  [%s] %s" % (area, detail))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
