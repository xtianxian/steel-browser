# Webchat integration

This branch combines upstream main `1131a0222a27f391bf8f27cca6f278ddf7ace8dd`,
the session ownership and bounded-launch repairs proposed in upstream PR #375,
and the Webchat casting adapter and Chromium extension launch configuration.
The casting files preserve the installed Webchat viewer behavior at integration.

Webchat pins this source through its `vendor/steel-browser` Git submodule.
Initialize that submodule at its recorded commit, never a moving branch tip.
Use the same source for PC builds and Cloud builds. Runtime dependencies and
browser profiles remain separate from source and must not be committed.

The local Webchat profile is shared for authentication and retained across
upgrades. Session-scoped release protects singleton ownership; these repairs
do not provide independently isolated concurrent CDP browsers.

Upstream PR #375 remains independently reviewable without Webchat-specific patches.
Additional open upstream PRs are excluded from this alignment.
