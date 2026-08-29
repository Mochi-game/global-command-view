# Why a certificate bundle is in here

This is Mozilla's list of trusted certificate authorities, as packaged by the
[certifi](https://github.com/certifi/python-certifi) project. 143 roots, and the
app does not use it unless it has to.

## What it is for

Windows does not ship every root certificate. It fetches one the first time
something asks, through CryptoAPI — and Python never asks. It copies whatever is
already in the Windows store and verifies with OpenSSL, so on a fresh machine
Python fails to verify hosts the same computer's browser reaches without
trouble.

Reported exactly that way: radio, airports, runways and weather all empty while
shortwave and aircraft worked, with `certificate verify failed: unable to get
local issuer certificate` in the log.

`warm-certificates.ps1` asks Windows on Python's behalf during installation and
fixes it on most machines. This is for the ones it cannot reach: a computer
blocked from Windows Update's certificate list has no way to obtain the root at
all, and no amount of asking will produce it.

## When it is used

Never first. Every request is made against the operating system's own trust
store, exactly as before. Only a request that fails **with a certificate error**
is retried against this file.

That order matters. The system store is current and this file is a snapshot that
ages, so a healthy machine should never touch it — and one that would otherwise
have shown nothing at all gets a second, still properly verified, attempt.

What it is not is a way to skip verification. There is no option in this app to
do that, and there should not be: it would fix an empty layer by making every
connection unchecked, on a machine already known to have a broken trust store.

## Licence

The bundle is Mozilla's, redistributed by certifi under the
**Mozilla Public License 2.0**. Its content is not this project's work and is
not covered by this repository's MIT licence.

Replace it with a newer copy whenever you like — any `cacert.pem` in PEM format
will do.
