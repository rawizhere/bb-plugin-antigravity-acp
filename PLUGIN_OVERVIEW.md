# Google Antigravity (ACP) for bb

Run bb threads on Google Antigravity through its official ACP server
(agy_acp_server.par).

## What it does

Registers the provider `acp-antigravity` in bb with full ACP support: dynamic
model catalog, reasoning levels, default/fast service tiers, in-band Google
authentication (account, Gemini API key, or Agent Platform), and health-gated
visibility — the provider only appears on machines where the server binary is
installed and the probe passes.

## Machine install

`bb google-antigravity-acp install` downloads the official zip, extracts it
without unzip/bsdtar dependencies, links the server binary and sandbox helper
onto PATH per machine, and can update PATH on Windows with `--update-path`.
`bb google-antigravity-acp status` shows the resolved binary and provider
state. Installs run via host RPC on the machine where the daemon executes.

## Links

- Repository: https://github.com/rawizhere/bb-plugin-antigravity-acp
- bb: https://github.com/get-bb/bb
