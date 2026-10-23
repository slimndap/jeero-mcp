# Desktop configuration tests — 2026-10-23

Real desktop sessions, signed into Claude with the requested account. All keys were fictitious and entered only in the browser configuration form. The fixture used the actual compiled Jeero server against a loopback Mother replacement; no real Mother or ticketing provider was contacted.

| Host | Observed behavior | Result |
| --- | --- | --- |
| Claude Code in Claude Desktop 2.42304.0, engine 2.1.299 | Advertised URL elicitation, then automatically returned `decline` without showing a URL prompt. Jeero returned the manual link and access code. | Browser save, safe subscription summary, sync, redacted logs and generic upstream error passed. |
| Claude Code in Claude Desktop 3.6556.2, engine 2.1.308 | Same URL capability and automatic decline. | Repeated browser save, summary, sync and redacted logs passed. |
| Cowork/local-agent mode in Claude Desktop 3.6556.2 | Actual tool client `local-agent-mode-jeero_desktop_test` 1.0.0 advertised no elicitation capability. Jeero directly returned the manual link. | Browser save, safe summary, sync, redacted logs and generic upstream error passed. |
| Codex Desktop 26.1016.62342 | Native automation explicitly denied access to the Codex app. Its bundled CLI 0.163.0-alpha.11.2 advertised URL elicitation, but stopped before calling the configuration tool because approval was required with approval policy `never`. | Initial automated attempt blocked. A later user-assisted Codex test completed the manual-link flow; see below. |

A subsequent user-assisted test used `jeero_test` in this Codex desktop chat. `config_subscription` returned a manual link and access code; the user opened and filled the page without agent browser tools. `get_subscription` then reported `configuration_complete: true` and zero connection errors, forced sync succeeded, and `get_logs` returned `Fixture upstream echoed [REDACTED]`. This confirms the manual-link flow; it does not confirm a native URL elicitation dialog or a real Stager connection. The Codex test entry was left installed at the user’s request, outside this repository. No browser-entered value was retrieved for this check.

Claude activated a pending update during the required restart. The Code test was repeated after that update. Cowork did not inherit the Code project's `.mcp.json`, so it was tested with a temporary desktop MCP entry instead.

The saved values were checked using SHA-256 hashes. No dummy key occurred in captured server MCP messages or trace logs. The fake upstream deliberately echoed the saved key in a log and in an HTTP 403 response; chat-facing results contained `[REDACTED]` or a generic error. This verifies the exercised paths, not every possible upstream response.

The original desktop MCP configuration was restored and compared with its backup. Claude subsequently updated its own `sidebarMode` preference. The temporary project MCP entry and private configuration backup were removed, Claude restarted, and no fixture processes remained. Test chats were retained. These tests did not publish anything.

Sanitized handshake, call and verification evidence: [desktop-results-2026-10-23.json](desktop-results-2026-10-23.json). Raw session traces and dummy-key databases were kept outside the repository in the temporary test directory.

## Repeat

1. Build with `npm run build`.
2. Create a temporary directory whose basename starts with `jeero-desktop-test-`.
3. Configure a test MCP server using an absolute Node executable, the absolute path to `test/manual/desktop-fixture.mjs` as its argument, and `JEERO_DESKTOP_TEST_ROOT` set to that directory. For Code use a project `.mcp.json`; for Cowork use its desktop MCP configuration and restart. Preserve existing settings.
4. Ask the actual host to call `config_subscription` with `subscription_key: "desktop-flow"`, without `manual` or settings. Observe the advertised capability, any elicitation response and fallback link.
5. Open the returned link, enter its access code, and save a fictitious test value in the password field. Then call `get_subscription`, `sync_subscription` with `force: true`, and `get_logs` in the host.
6. The fixture writes per-connection `status.json` with a hash only. Check it matches the browser value and inspect outgoing MCP messages and trace logs for leaks. Create a `fail` file inside that connection directory to exercise a raw upstream error, then call `get_subscription` again.
7. Remove the test MCP entry, restore existing settings and restart the host to stop the fixture. Never use real credentials with this recording fixture.
