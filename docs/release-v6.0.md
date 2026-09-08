# Global Command View 6.0

A new way into the globe: choose what interests you, find layers quickly, and control the map with Swedish or English commands.

## What is new

- **Four starting views:** Aviation, Oceans, Our planet and Sweden select useful layers and move the camera to a relevant region.
- **A redesigned interface:** clearer typography, searchable layers, an Active only filter, a hideable sidebar and layouts for smaller screens.
- **Commands:** press Ctrl+K (Command+K on Mac). Try `visa flyg i Stockholm`, `go to London`, `show earthquakes`, `sammanfatta` or `ångra`.
- **Optional voice input:** choose Swedish or English, press Speak, review the transcript and press Run. Optional spoken replies read the English interface response aloud.
- **Saved views:** keep up to eight named camera/layer combinations in your browser and reopen them later.
- **Undo:** restore the camera position and layers from before your last command or starting view.
- **Keyboard access:** layer switches and section headings support Enter and Space. Place searches now time out with a useful message.

## Download and upgrade

Download **GlobalCommandView-6.0.zip**, extract it, and use **Start Global Command View.cmd** on Windows. For a first installation, use **Install Global Command View.cmd**. macOS users should read the included Mac instructions.

Keep a copy of your current folder before upgrading. Preserve your own `keys.json` and `data` files; personal keys and saved data are not included in this package. Restart the local server after upgrading and reload the browser. The version badge should say **v6.0**.

## Good to know

The Python server is still required. The responsive interface does not turn this into a standalone mobile app or a hosted service.

Commands are deterministic map controls, not a general AI chatbot. Summaries report loaded records and source availability, not an independent analysis of world events. Existing data-source terms and coverage limitations still apply.

Speech recognition depends on your browser, microphone permission and a localhost or HTTPS connection. The browser may process audio through its speech provider. Typed commands work without a microphone or an AI account. Saved views remain local to the browser.

## Validation

Six command regression tests passed, including every actual layer name, Swedish aliases and stored-view validation. The existing quick smoke test passed; it skips heavier external feeds. Browser checks covered presets, layer commands, undo, coordinate navigation, filters, saved-view persistence, keyboard input and a 390 × 844 mobile layout.

Actual microphone recognition and spoken audio have not been verified end to end. Advanced mapping tools and the alternate Google 3D view have not all been retested.
