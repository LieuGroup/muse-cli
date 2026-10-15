import type { Command } from "../context.js";
import { browserCommand } from "./browser.js";
import {
  askCommand,
  cancelCommand,
  chatCommand,
  historyCommand,
  watchCommand,
} from "./chat.js";
import {
  catCommand,
  findCommand,
  getCommand,
  lsCommand,
  putCommand,
} from "./files.js";
import { mediaCommand, podcastsCommand } from "./library.js";
import { artifactsCommand } from "./media.js";
import { nodesCommand } from "./nodes.js";
import {
  connectorsCommand,
  effortCommand,
  modelCommand,
  skillsCommand,
} from "./settings.js";
import {
  authCommand,
  callCommand,
  healthCommand,
  methodsCommand,
  statusCommand,
  versionCommand,
  vmsCommand,
} from "./system.js";
import { threadsCommand } from "./threads.js";
import {
  activityCommand,
  goalsCommand,
  memoryCommand,
  subagentsCommand,
  tasksCommand,
} from "./work.js";

export const COMMANDS: Readonly<Record<string, Command>> = {
  ask: askCommand,
  chat: chatCommand,
  history: historyCommand,
  cancel: cancelCommand,
  watch: watchCommand,
  threads: threadsCommand,
  model: modelCommand,
  effort: effortCommand,
  skills: skillsCommand,
  connectors: connectorsCommand,
  tasks: tasksCommand,
  goals: goalsCommand,
  memory: memoryCommand,
  activity: activityCommand,
  subagents: subagentsCommand,
  browser: browserCommand,
  nodes: nodesCommand,
  artifacts: artifactsCommand,
  media: mediaCommand,
  podcasts: podcastsCommand,
  ls: lsCommand,
  cat: catCommand,
  get: getCommand,
  put: putCommand,
  find: findCommand,
  status: statusCommand,
  health: healthCommand,
  auth: authCommand,
  vms: vmsCommand,
  methods: methodsCommand,
  call: callCommand,
  version: versionCommand,
};

/** Friendly aliases. */
export const ALIASES: Readonly<Record<string, string>> = {
  sessions: "threads",
  thread: "threads",
  devices: "nodes",
  node: "nodes",
  logs: "watch",
  tail: "watch",
  info: "status",
  "-v": "version",
  "--version": "version",
};
