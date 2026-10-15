export const HELP = `muse — drive your Muse agent from the terminal

USAGE
  muse <command> [args] [flags]

CHAT
  ask "<message>"        Send a message, stream the reply (reads stdin with "-")
                           --thread ID  --timeout SEC  --quiet
                           --save-media DIR  download images/audio/files it made
  chat                   Interactive chat (REPL). /cancel, /exit
  history                Recent transcript            [--limit N] [--thread ID]
  cancel                 Stop the running reply       [--thread ID]
  watch                  Stream live events (NDJSON when piped)
                           --events delta.*,agent.status  --seconds N
  threads                List threads
  threads new [title]    Start a new thread
  threads rename <id> <title> | archive <id> | unarchive <id>

AGENT SETTINGS
  model                  List models (* = selected)
  model set <id>         Switch model
  effort [level]         Show / set reasoning effort   [--agent root|sub|both]
  skills [--search q]    List skills
  skills enable|disable <name>
  connectors [--all]     Connected integrations

WORK
  tasks                  Scheduled tasks
  tasks run <id>         Run a task now               [--reason text]
  tasks runs <id>        Recent runs of a task        [--limit N]
  goals [id]             Goals the agent is tracking
  memory "<query>"       Search the agent's memory    [--limit N]
  activity               What the agent has been doing [--limit N]
  subagents              Recent and active sub-agents

CREATIONS
  artifacts              Documents and web apps the agent made [--type web|documents]
  artifacts get <#|name> [dir]   Download one (web apps export as .html)
  media                  Images, audio and video in the agent's library
  media get <#|name|all> [dir]
  podcasts               Podcast episodes
  podcasts get <#|slug> [dir]
  (Create new ones by asking:  muse ask "make an image of …" --save-media .)

BROWSER (the agent's live browser)
  browser                Running browser tasks (URL, who has control)
  browser shot [#] [dir] Download the latest screenshot
  browser vnc [#]        Local VNC bridge: vnc://127.0.0.1:5900 [--port N] [--open]
  browser takeover|release|stop [#]   Take/return control, or stop the task

DEVICES (your Mac/iPhone, paired through the Muse app)
  nodes                  Paired devices, online state, ready commands
  nodes <#|mac|iphone>   That device's commands and the permissions each needs
  nodes <#> <command>    Full description and parameters of one command
  (Muse calls these itself:  muse ask "summarise my unread iMessages")

FILES (relative to the agent's home, ~)
  ls [path] [--all]      List a directory
  cat <path>             Print a file
  get <path> [local]     Download a file
  put <local> <path>     Upload a file                [--append]
  find <name> [--in path]

ACCOUNT / SYSTEM
  status                 One-glance overview
  auth                   Check the session
  vms                    List agent VMs
  health                 Full VM diagnostics (JSON)
  methods [filter]       Gateway RPC catalog
  call <method> [json]   Call any RPC   [--allow-unsafe] [--seconds N]
  version | help

GLOBAL FLAGS
  --json                 Machine-readable output
  --vm ID|NAME           Target a specific VM
  --profile NAME         Chrome profile (default "Default"; env MUSE_CHROME_PROFILE)
  --cookie "…"           Cookie header instead of Chrome (env MUSE_COOKIE)
  --cookie-file PATH     cookies.txt / Cookie header file (env MUSE_COOKIE_FILE)

AUTH
  On macOS, muse reads your logged-in muse.ai session from Chrome automatically.
  Elsewhere, set MUSE_COOKIE or MUSE_COOKIE_FILE.

EXIT CODES
  0 ok · 1 failure · 2 usage · 3 not authenticated · 4 unsupported (e.g. confidential VM)
`;
