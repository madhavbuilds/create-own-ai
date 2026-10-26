# Security

Apps made with create-local-ai are meant to run on your own computer and listen only on `127.0.0.1`.
The server rejects requests whose `Host` isn't localhost (DNS rebinding) and state-changing requests from other origins.

If you find a way for a website, another user, or another machine to read or change a user's files or chats,
please report it privately through [GitHub security advisories](https://github.com/madhavbuilds/create-local-ai/security/advisories/new)
rather than a public issue.
