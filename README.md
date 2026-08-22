# MsgDel

A [Vencord](https://vencord.dev) user plugin that deletes **your own** messages in a channel or across an entire server.

MsgDel never deletes messages sent by other users. Discord only allows a user to delete their own messages unless they have moderator permissions; this plugin does not use moderator delete.

## Features

- Delete your messages in a channel, DM, group DM, or thread
- Delete your messages across a whole guild
- Confirmation prompt before a run starts
- Progress bar with a stop button
- Context menu, plugin settings, toolbox actions, and `/msgdel`
- Automatic fallback to channel history if Discord search is unavailable
- Configurable delays to stay within Discord rate limits

## Requirements

MsgDel is a **user plugin**. It requires a [Vencord install built from source](https://docs.vencord.dev/installing/). The standard Vencord installer does not load user plugins.

Equicord is supported through the same `src/userplugins` layout.

## Installation

1. Install Vencord from source: https://docs.vencord.dev/installing/
2. Create `src/userplugins` in your Vencord directory if it does not exist
3. Clone this repository into a camelCase folder:

```bash
git clone https://github.com/Who1sme6/MsgDel.git src/userplugins/msgDel
```

Alternatively, copy `index.tsx` to `src/userplugins/msgDel/index.tsx`.

4. From the Vencord root directory, rebuild:

```bash
pnpm build
```

5. Fully restart Discord
6. Open **Settings → Vencord → Plugins** and enable **MsgDel**

## Usage

After the plugin is enabled:

| Action | How |
| --- | --- |
| Current channel / DM / group | Right-click the channel → **Delete my messages** |
| Entire server | Right-click the server → **Delete my messages on this server** |
| Settings | Plugin settings → **Current chat** / **Current server** |
| Command | `/msgdel`, `/msgdel scope:server`, `/msgdel scope:stop` |

A progress bar appears at the top of the client, including a **Stop** button.

If confirmation is enabled, MsgDel asks before starting. Deleted messages cannot be recovered.

## Settings

| Setting | Description |
| --- | --- |
| Confirm before delete | Show a confirmation dialog before a run |
| Delete delay | Pause between deletions. Default: `1200` ms. Minimum: `1000` ms |
| Search delay | Pause between Discord search requests. Default: `2500` ms |

A delete delay below `1000` ms increases the chance of Discord rate limits or a temporary restriction.

## Notes

- Only messages authored by the signed-in account are deleted
- System messages (joins, boosts, calls, and similar) are skipped
- Discord search can lag; MsgDel re-checks several times before treating a run as finished
- If search is unavailable, MsgDel falls back to scanning channel history
- Bulk requests from a user client are against Discord’s Terms of Service. Use conservative delays and do not run this continuously

## License

This project is licensed under [GPL-3.0-or-later](LICENSE), the same license as Vencord.
