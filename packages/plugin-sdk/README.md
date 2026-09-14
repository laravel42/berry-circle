# @berry/plugin-sdk

Build a Berry plugin: a web service that Berry calls on events and schedules,
that can show pages inside Berry, and that calls back through Berry's public API.

1. **Describe it.** Write `berry-plugin.json` (see `examples/hello`). It lists
   the scopes, settings, secrets, hooks, pages and agent tools the plugin needs.
2. **Install it.** In Berry, open Settings → Plugins. Paste the URL that serves
   the file, or upload it, then review the preview and click Install.
3. **Keep the signing secret.** It is shown once. Put it in your plugin's
   environment, for example as `BERRY_SIGNING_SECRET`.
4. **Handle hooks.** Serve `createHookHandler({ signingSecret, onEvent, onSchedule })`
   at each hook path. It refuses unsigned calls and calls older than five
   minutes. Each call carries a short-lived token, and `api` is a
   `BerryClient` already bound to it.
5. **Show pages.** In the page's script, call `readSurfaceLaunch(location.hash)`,
   clear `location.hash`, then use `new BerryClient({ apiUrl, token })`.

**Write-back loops.** If a hook writes to Berry, for example by commenting on
`comment.created`, Berry tells the plugin about that write too. Skip events
your plugin caused.
