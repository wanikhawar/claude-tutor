# Security Policy

## Supported versions

Only the latest release of Claude Tutor gets security fixes. Please update to it before reporting.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through
[GitHub's private vulnerability reporting](https://github.com/wanikhawar/claude-tutor/security/advisories/new)
(**Security → Report a vulnerability** on the repository).

Include what you found, how to reproduce it, and which versions of the plugin, Obsidian and Claude Code you used.
You should hear back within a week. Once a fix is released, the advisory is published and you're credited unless
you'd rather not be.

## Scope

Claude Tutor runs the `claude` CLI on your machine and reads the notes and PDFs in the folders you choose.
Issues that are in scope include, for example:

- note or PDF content making the plugin run commands, or read or write files, outside what it's meant to
- vault content or Claude's replies injecting script or HTML into the tutor view
- releases whose files don't match their build attestation

Vulnerabilities in Obsidian, Claude Code or poppler themselves should go to those projects.
