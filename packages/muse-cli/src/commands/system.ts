import {
  findRoute,
  listChromeProfilesWithMuse,
  MUSE_VERSION,
  RPC_ROUTES,
} from "muse-agent-core";
import {
  type Command,
  EXIT,
  printJson,
  usageError,
  withGateway,
} from "../context.js";
import { flagNumber } from "../parse-argv.js";
import { bold, dim, green, red, table } from "../render.js";

export const versionCommand: Command = async (ctx) => {
  ctx.io.out(MUSE_VERSION);
  return EXIT.ok;
};

/** `muse auth` — is the session cookie valid? Lists Chrome profiles found. */
export const authCommand: Command = async (ctx) => {
  const session = await ctx.session();
  const ok = await session.check();
  const profiles = await listChromeProfilesWithMuse().catch(() => []);
  if (ctx.json) {
    printJson(ctx, {
      authenticated: ok,
      chrome_profiles_with_session: profiles,
    });
  } else {
    ctx.io.out(
      ok
        ? green("authenticated")
        : red("NOT authenticated — log in at muse.ai in Chrome"),
    );
    if (profiles.length > 0) {
      ctx.io.out(
        dim(
          `Chrome profiles with a muse.ai session: ${profiles.join(", ")} (pick one with --profile)`,
        ),
      );
    }
  }
  return ok ? EXIT.ok : EXIT.auth;
};

/** `muse vms` */
export const vmsCommand: Command = async (ctx) => {
  const vms = await (await ctx.session()).listVms();
  if (ctx.json) {
    printJson(ctx, vms);
    return EXIT.ok;
  }
  if (vms.length === 0) {
    ctx.io.out("No VMs assigned. Open muse.ai once to provision one.");
    return EXIT.ok;
  }
  const rows = vms.map((v) => [
    v.isPreferred ? green("*") : " ",
    v.vmName ?? v.vmId ?? "?",
    v.vmType ?? "standard?",
    v.vmState ?? "?",
  ]);
  ctx.io.out(table(["", "VM", "TYPE", "STATE"], rows));
  return EXIT.ok;
};

/** `muse status` — one-glance overview of the agent. */
export const statusCommand: Command = async (ctx) =>
  withGateway(ctx, async ({ gateway, vm }) => {
    const [model, cfg, health, tasks] = await Promise.all([
      gateway.request("model.get") as Promise<{ selected_model: string }>,
      gateway.request("config.get") as Promise<{
        llm?: { reasoning?: Record<string, { effort?: string }> };
      }>,
      gateway.request("vm.health") as Promise<Record<string, unknown>>,
      gateway.request("tasks.list") as Promise<{ schedules: unknown[] }>,
    ]);
    const summary = {
      vm: vm.vmName ?? vm.vmId,
      vm_type: gateway.vmType,
      vm_state: vm.vmState,
      healthy: health.all_healthy,
      turn_active: health.root_turn_active,
      model: model.selected_model,
      effort_root: cfg.llm?.reasoning?.root_agent?.effort,
      effort_subagent: cfg.llm?.reasoning?.subagent?.effort,
      scheduled_tasks: tasks.schedules.length,
      devices: health.device_count,
    };
    if (ctx.json) {
      printJson(ctx, summary);
      return EXIT.ok;
    }
    for (const [k, v] of Object.entries(summary)) {
      ctx.io.out(`${dim(k.padEnd(16))} ${bold(String(v ?? "-"))}`);
    }
    return EXIT.ok;
  });

/** `muse health` — full VM diagnostics (JSON). */
export const healthCommand: Command = async (ctx) =>
  withGateway(ctx, async ({ gateway }) => {
    printJson(ctx, await gateway.request("vm.health"));
    return EXIT.ok;
  });

/** `muse methods [filter]` — the RPC catalog (offline). */
export const methodsCommand: Command = async (ctx) => {
  const filter = ctx.args.positionals[0];
  const rows = RPC_ROUTES.filter((r) => !filter || r.method.includes(filter));
  if (ctx.json) {
    printJson(ctx, rows);
    return EXIT.ok;
  }
  const lines = rows.map((r) => [
    r.method,
    r.httpMethod,
    r.service,
    r.safety,
    `${r.path}${r.streamMode ? `  [${r.streamMode}]` : ""}`,
  ]);
  ctx.io.out(table(["METHOD", "VERB", "SERVICE", "SAFETY", "PATH"], lines));
  ctx.io.out(dim(`\n${rows.length} methods`));
  return EXIT.ok;
};

function parseParams(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    usageError("params must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** `muse call <method> [json] [--allow-unsafe] [--seconds N]` */
export const callCommand: Command = async (ctx) => {
  const method = ctx.args.positionals[0];
  if (!method)
    usageError("usage: muse call <method> [json-params] [--allow-unsafe]");
  const route = findRoute(method);
  if (!route) usageError(`unknown method: ${method} (see \`muse methods\`)`);
  const unsafe = route.safety === "destructive" || route.safety === "sensitive";
  if (unsafe && ctx.args.flags["allow-unsafe"] !== true) {
    usageError(
      `${method} is tagged "${route.safety}". Re-run with --allow-unsafe if you really mean it.`,
    );
  }
  const params = parseParams(ctx.args.positionals[1]);
  return withGateway(ctx, async ({ gateway }) => {
    if (!route.streamMode) {
      printJson(ctx, await gateway.request(method, params));
      return EXIT.ok;
    }
    const seconds = flagNumber(ctx.args.flags, "seconds") ?? 30;
    const sub = gateway.subscribe(method, params, (ev) =>
      ctx.io.out(JSON.stringify(ev)),
    );
    ctx.io.out(JSON.stringify({ ack: await sub.ack }));
    await Promise.race([
      sub.done,
      new Promise((r) => setTimeout(r, seconds * 1000)),
    ]);
    sub.close();
    return EXIT.ok;
  });
};
