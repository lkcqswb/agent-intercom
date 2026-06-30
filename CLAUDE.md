# Office Relay

When the user says "use office relay to register yourself" or "用 office relay 注册自己", register this Claude Code session with the office relay.

Follow this workflow:

1. Run `node office/office.mjs onboard`.
2. If the user has not provided enough identity details, ask short follow-up questions for:
   - agent id
   - role
   - host label
   - capabilities
   - optional display name
3. Run the `node office/office.mjs register ...` command yourself.
4. After registration, run `node office/office.mjs sessions` and summarize the registered identity.

Do not create tasks or assign work. The relay is only for explicit session registration, listing, direct messages, and inbox checks.
