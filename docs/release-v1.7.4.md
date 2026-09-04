A small one. The self-check was blaming every feed in the app for a fault that
was none of theirs.

## Download

**GlobalCommandView-1.7.4.zip** below.

Right-click the ZIP before unpacking it, choose Properties, tick **Unblock**,
then extract — that saves you every Windows warning afterwards. Then run
**Install Global Command View.cmd**.

> ### ⚠ Upgrading? Copy two things first
>
> Copy **`keys.json`** and the **`data`** folder somewhere safe before you
> install over an existing copy. That is every key you have set up and every view
> you have saved.
>
> Unpacking over the old folder does not touch them — they are kept out of the
> download on purpose. The ways people lose them are deleting the old folder to
> start clean, or unpacking somewhere new and later tidying away the folder the
> keys were still in. Ten seconds, and the risk is gone. Nothing here is
> recoverable from anyone else.

## The self-check blamed sixty feeds for one dead server

Reported from a run of **Check Global Command View**: every endpoint printed
`FAILED`, most of them `[WinError 10061]` — the connection refused. It reads as
though every source in the app has stopped answering, which is alarming and
wrong.

Not one of them had been asked anything. The check starts its own server on a
free port and calls the endpoints through it. That server took the first
connection and went away, so every call after it was refused by nothing at all.
Each `FAILED` line was true about the call and false about the feed.

**The server is now asked whether it is there before it is asked about the
world.** `/api/version` is the app's own statement that it started, so it goes
first. If it does not answer, the run stops with one line naming the port and
the error, and says plainly that the feeds were not called:

```
endpoints
  the server is not answering on 8820 - nothing was asked of the feeds

--------------------------------------------------------------
1 problem
  [server] not answering on port 8820 (...). The feeds were not called,
  so nothing here says anything about them.
```

Two smaller changes behind it. **A server that dies part-way through is
noticed** before the next feed is blamed, so the run stops rather than printing
a column of refusals. And **what the server said is kept** — its output went to
nowhere, which is the difference between *the server exited* and knowing why. It
goes to a temporary file now, and the last lines are quoted in the failure.

The run that started this passed on the next attempt with every feed answering.
Nothing was wrong with the app. The test was wrong about where to point.

## Also in the download

Seven files that shipped to every user and no user needed are out of the archive:
the release notes, which are written to help somebody decide whether to
download and are answered by the time the archive is open; a working file from
the radar colour work that nothing references; `FUNDING.yml`, which only GitHub
reads; and the two git files that describe how the repository is checked out.

`CHANGELOG.md` stays, and so do the screenshots, because `README.md` points at
them.

Full detail in `CHANGELOG.md`.
