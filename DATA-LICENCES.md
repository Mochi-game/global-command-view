# What the data allows

The MIT licence in `LICENSE` covers **the code in this repository and nothing
else.** It is kept as plain MIT with nothing appended, because a licence file
with extra paragraphs stops being recognised as MIT — by GitHub, and by anyone
scanning dependencies. This file is where the rest of the story lives.
This licence covers the code in this folder and nothing else.

The app displays data from a number of outside services, and those come with
their own terms — several of them permit non-commercial use only. The MIT
licence above does not grant any right to their data. See the
SOURCES & LICENCES tab in the app, or the table in README.md, for what each
feed allows.

In short: this software may be given away freely, but the live picture it draws
may not be sold without licences from the providers behind it.

## The certificate bundle in `certs/`

`certs/cacert.pem` is Mozilla's list of trusted certificate authorities, as
packaged by [certifi](https://github.com/certifi/python-certifi) and
redistributed here under the **Mozilla Public License 2.0**. It is not this
project's work and the MIT licence above does not cover it.

It is there because Windows fetches a root certificate only when something asks,
and Python never asks. On a machine that cannot reach Windows Update's
certificate list, every HTTPS feed fails with *unable to get local issuer
certificate* while the same computer's browser works fine. The app tries the
operating system's own store first and only falls back to this file when that
comes back with a certificate error - so a healthy machine never touches it.
See `certs/README.md`.
