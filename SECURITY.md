# Security policy

## Supported versions

Before v1.0.0, only the latest public release of `@discord-mcp/cli` and
`@discord-mcp/core` receives security fixes. Upgrade before reproducing a
report when it is safe to do so. If an older release is affected, identify it
in the private report.

## Report a vulnerability

Do not open a public GitHub issue for a suspected vulnerability, authorization
or guild-boundary bypass, cross-caller data exposure, or credential leak. Use
[GitHub private vulnerability reporting](https://github.com/cappyeo/discord-mcp/security/advisories/new)
so the report and any fix can be coordinated privately.

Include the affected version, MCP transport, impact, minimal reproduction, and
redacted evidence. Never include a bot token, authorization header, webhook
credential, complete client configuration, private server/member data, or
unredacted Discord identifiers. Rotate any credential that may already have
been exposed; a private advisory is not a secret store.

For ordinary setup, compatibility, correctness, or performance bugs, use the
[public bug report form](https://github.com/cappyeo/discord-mcp/issues/new?template=bug-report.yml).
