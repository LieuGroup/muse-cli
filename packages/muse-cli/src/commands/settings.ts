import {
  type Command,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { bold, dim, green, table, truncate } from "../render.js";

interface ModelInfo {
  id: string;
  display_name?: string;
  context_window_tokens?: number;
  preview_model?: boolean;
}

/** `muse model [set <id>]` */
export const modelCommand: Command = async (ctx) => {
  const [sub, value] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    if (sub === "set") {
      if (!value)
        usageError("usage: muse model set <model-id>   (see `muse model`)");
      const res = await gateway.request("model.set", { model: value });
      if (ctx.json) printJson(ctx, res);
      else ctx.io.out(`Model set to ${bold(value)}.`);
      return EXIT.ok;
    }
    if (sub) usageError("usage: muse model [set <model-id>]");
    const res = (await gateway.request("model.get")) as {
      selected_model: string;
      default_model: string;
      available_models: ModelInfo[];
    };
    if (ctx.json) {
      printJson(ctx, res);
      return EXIT.ok;
    }
    ctx.io.out(
      table(
        ["", "MODEL", "NAME", "CONTEXT"],
        res.available_models.map((m) => [
          m.id === res.selected_model ? green("*") : " ",
          m.id,
          `${m.display_name ?? ""}${m.preview_model ? " (preview)" : ""}`,
          m.context_window_tokens
            ? `${Math.round(m.context_window_tokens / 1000)}k`
            : "-",
        ]),
      ),
    );
    return EXIT.ok;
  });
};

const EFFORTS = ["minimal", "low", "medium", "high"] as const;

/** `muse effort [<level>] [--agent root|sub|both]` */
export const effortCommand: Command = async (ctx) => {
  const [level] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    const cfg = (await gateway.request("config.get")) as {
      llm?: { reasoning?: Record<string, { effort?: string }> };
    };
    const reasoning = cfg.llm?.reasoning ?? {};
    if (!level) {
      if (ctx.json) printJson(ctx, reasoning);
      else {
        ctx.io.out(`root agent: ${bold(reasoning.root_agent?.effort ?? "?")}`);
        ctx.io.out(`sub-agents: ${bold(reasoning.subagent?.effort ?? "?")}`);
      }
      return EXIT.ok;
    }
    if (
      !(EFFORTS as readonly string[]).includes(level) &&
      ctx.args.flags.force !== true
    ) {
      usageError(
        `effort "${level}" is not one of ${EFFORTS.join(", ")}. Pass --force to send it anyway.`,
      );
    }
    const target = String(ctx.args.flags.agent ?? "both");
    const keys =
      target === "root"
        ? ["root_agent"]
        : target === "sub"
          ? ["subagent"]
          : ["root_agent", "subagent"];
    const next: Record<string, { effort: string }> = {};
    for (const k of keys) next[k] = { effort: level };
    await gateway.request("config.update", { llm: { reasoning: next } });
    // Read back: the server is the authority on which values it accepts.
    const after = (await gateway.request("config.get")) as {
      llm?: { reasoning?: Record<string, { effort?: string }> };
    };
    const applied = after.llm?.reasoning ?? {};
    if (ctx.json) {
      printJson(ctx, applied);
      return EXIT.ok;
    }
    for (const k of keys) {
      const now = applied[k]?.effort ?? "?";
      ctx.io.out(
        `${k}: ${bold(now)}${now === level ? "" : dim(`  (requested ${level}; server kept ${now})`)}`,
      );
    }
    return EXIT.ok;
  });
};

interface SkillInfo {
  name: string;
  title?: string;
  description: string;
  category: string;
  enabled?: boolean;
  disabled?: boolean;
  user_disabled?: boolean;
  status?: string;
}

/** `muse skills [enable|disable <name>] [--search text]` */
export const skillsCommand: Command = async (ctx) => {
  const [sub, name] = ctx.args.positionals;
  return withGateway(ctx, async ({ gateway }) => {
    if (sub === "enable" || sub === "disable") {
      if (!name) usageError(`usage: muse skills ${sub} <name>`);
      const res = await gateway.request("skills.set_disabled", {
        name,
        disabled: sub === "disable",
      });
      if (ctx.json) printJson(ctx, res);
      else ctx.io.out(`Skill ${bold(name)} ${sub}d.`);
      return EXIT.ok;
    }
    if (sub)
      usageError("usage: muse skills [enable|disable <name>] [--search text]");
    const res = (await gateway.request("skills.list")) as {
      skills: SkillInfo[];
    };
    const search =
      typeof ctx.args.flags.search === "string"
        ? ctx.args.flags.search.toLowerCase()
        : "";
    const skills = res.skills.filter(
      (s) =>
        !search || `${s.name} ${s.description}`.toLowerCase().includes(search),
    );
    if (ctx.json) {
      printJson(ctx, skills);
      return EXIT.ok;
    }
    ctx.io.out(
      table(
        ["SKILL", "STATE", "DESCRIPTION"],
        skills.map((s) => [
          s.name,
          s.user_disabled || s.disabled ? dim("off") : "on",
          truncate(s.description, 80),
        ]),
      ),
    );
    ctx.io.out(dim(`\n${skills.length} skills`));
    return EXIT.ok;
  });
};

interface ConnectorInfo {
  id: string;
  name: string;
  description?: string;
  state: string;
  management_kind?: string;
}

/** `muse connectors [--all]` */
export const connectorsCommand: Command = async (ctx) =>
  withGateway(ctx, async ({ gateway }) => {
    const res = (await gateway.request("connectors.list")) as {
      connectors: ConnectorInfo[];
    };
    const all = ctx.args.flags.all === true;
    const rows = res.connectors.filter((c) => all || c.state === "connected");
    if (ctx.json) {
      printJson(ctx, rows);
      return EXIT.ok;
    }
    ctx.io.out(
      table(
        ["CONNECTOR", "STATE", "DESCRIPTION"],
        rows.map((c) => [
          c.id,
          c.state === "connected" ? green("connected") : dim(c.state),
          truncate(c.description ?? c.name, 70),
        ]),
      ),
    );
    if (!all) {
      ctx.io.out(
        dim(
          `\n${rows.length} connected of ${res.connectors.length}. Use --all to list every connector.`,
        ),
      );
    }
    return EXIT.ok;
  });
