// Vercel build entrypoint, run from the repository root (see apps/web/vercel.json).
//
// With the Convex Vercel Marketplace integration installed, CONVEX_DEPLOY_KEY is
// available at build time. The script then:
//   1. ensures the Convex deployment has the env vars Convex Auth needs
//      (JWT_PRIVATE_KEY, JWKS) plus a SITE_URL matching this Vercel deployment,
//   2. deploys Convex functions and builds the web app with
//      NEXT_PUBLIC_CONVEX_URL pointing at that deployment.
//
// Preview builds that only have a production deploy key skip the function
// deploy and build the frontend against the production deployment. Without any
// deploy key the script just builds the frontend (bring-your-own backend).
import { spawnSync } from "node:child_process";

const WEB_BUILD_COMMAND = "pnpm --filter @shulstack/web run build";

const deployKey = process.env.CONVEX_DEPLOY_KEY;
const vercelEnv = process.env.VERCEL_ENV ?? "production";

if (!deployKey) {
  log("CONVEX_DEPLOY_KEY is not set; building the web app without deploying Convex functions.");
  runWebBuild();
  process.exit(0);
}

const keyScope = deployKey.split(":")[0];
if (vercelEnv !== "production" && keyScope === "prod") {
  log(`${vercelEnv} build with a production deploy key: building the frontend only.`);
  if (!process.env.NEXT_PUBLIC_CONVEX_URL) {
    const deploymentName = deployKey.slice("prod:".length).split("|")[0];
    process.env.NEXT_PUBLIC_CONVEX_URL = `https://${deploymentName}.convex.cloud`;
    log(
      `Derived NEXT_PUBLIC_CONVEX_URL=${process.env.NEXT_PUBLIC_CONVEX_URL} from the deploy key.`,
    );
  }
  runWebBuild();
  process.exit(0);
}

// Preview-scoped keys authorize against a named preview deployment, not the
// project's dev deployment. `convex deploy` names that preview from the git
// branch; env list/set must use the same selector or they fail to authorize.
const convexEnvSelector = previewEnvSelector(keyScope);

// Fresh preview backends only exist after `convex deploy`, so tolerate failure
// before the deploy and require success after it.
ensureAuthEnv({ required: false });
run("pnpm", [
  "exec",
  "convex",
  "deploy",
  "--cmd-url-env-var-name",
  "NEXT_PUBLIC_CONVEX_URL",
  "--cmd",
  WEB_BUILD_COMMAND,
]);
ensureAuthEnv({ required: true });
log("Convex deploy and web build complete.");

function ensureAuthEnv({ required }) {
  const existing = convexEnvList();
  if (existing === null) {
    if (required) {
      console.error("Could not read env vars from the Convex deployment after deploying.");
      process.exit(1);
    }
    log("Convex deployment not reachable yet; will configure auth env vars after deploy.");
    return;
  }

  if (!existing.has("JWT_PRIVATE_KEY") || !existing.has("JWKS")) {
    log("Generating Convex Auth JWT keys for this deployment...");
    const { privateKey, jwks } = generateAuthKeysSync();
    convexEnvSet("JWT_PRIVATE_KEY", privateKey);
    convexEnvSet("JWKS", jwks);
  }

  const siteUrl = vercelSiteUrl();
  if (siteUrl && existing.get("SITE_URL") !== siteUrl) {
    convexEnvSet("SITE_URL", siteUrl);
  }
}

function vercelSiteUrl() {
  const host =
    vercelEnv === "production"
      ? process.env.VERCEL_PROJECT_PRODUCTION_URL
      : (process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL);
  return host ? `https://${host}` : undefined;
}

function previewName() {
  return process.env.VERCEL_GIT_COMMIT_REF || process.env.CI_COMMIT_REF_NAME || null;
}

function previewEnvSelector(scope) {
  if (scope !== "preview") {
    return [];
  }
  const name = previewName();
  if (!name) {
    console.error(
      "Preview deploy key requires VERCEL_GIT_COMMIT_REF (or CI_COMMIT_REF_NAME) to select the Convex preview deployment.",
    );
    process.exit(1);
  }
  return ["--preview-name", name];
}

function convexEnvList() {
  const result = spawnSync("pnpm", ["exec", "convex", "env", "list", ...convexEnvSelector], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  const vars = new Map();
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      vars.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return vars;
}

function convexEnvSet(name, value) {
  run("pnpm", ["exec", "convex", "env", "set", ...convexEnvSelector, "--", name, value], {
    quiet: true,
  });
  log(`Set ${name} on the Convex deployment.`);
}

function generateAuthKeysSync() {
  // spawnSync keeps the control flow simple; key generation itself is async.
  const result = spawnSync(process.execPath, ["scripts/generate-convex-auth-keys.mjs"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  const privateKey = result.stdout.match(/^JWT_PRIVATE_KEY="(.*)"$/m)?.[1];
  const jwks = result.stdout.match(/^JWKS=(.*)$/m)?.[1];
  if (!privateKey || !jwks) {
    console.error("generate-convex-auth-keys.mjs produced unexpected output.");
    process.exit(1);
  }
  return { privateKey, jwks };
}

function runWebBuild() {
  run("pnpm", ["--filter", "@shulstack/web", "run", "build"]);
}

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
  });
  if (result.status !== 0) {
    console.error(`Command failed: ${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function log(message) {
  console.log(`[vercel-build] ${message}`);
}
