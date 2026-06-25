import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.kickpages.com/api/v1/";

const BROWSER_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "en-US,en;q=0.9",
};

const AUTH_PATH = join(homedir(), ".claude", "kickpages-auth.json");
const PLAN_PATH = join(tmpdir(), "funnelai_plan.json");

// ---------------------------------------------------------------------------
// Auth management
// ---------------------------------------------------------------------------

async function readAuthStore() {
  try {
    return JSON.parse(await readFile(AUTH_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function writeAuthStore(store) {
  await mkdir(join(homedir(), ".claude"), { recursive: true });
  await writeFile(AUTH_PATH, JSON.stringify(store, null, 2), "utf-8");
}

async function signin(email, password) {
  const res = await fetch(`${BASE_URL}signin`, {
    method: "POST",
    headers: BROWSER_HEADERS,
    body: JSON.stringify({
      signin_detail: { txtEmail: email, txtPassword: password },
      loginfrom: "members",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (!res.ok || data.FLAG !== 1) {
    throw new Error(data.MSG || `Sign-in failed (HTTP ${res.status})`);
  }
  return {
    accessToken: data.TOKEN,
    refreshToken: data.REFRESH_TOKEN,
    accessExpiresAt: (data.DATA.accessExpireAt || 0) * 1000,
    refreshExpiresAt: (data.DATA.refreshExpireAt || 0) * 1000,
  };
}

async function refreshTokens(refreshToken) {
  const res = await fetch(`${BASE_URL}token`, {
    method: "POST",
    headers: { ...BROWSER_HEADERS, Authorization: `Bearer ${refreshToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (!res.ok || data.FLAG !== 1) {
    throw new Error(data.MSG || `Token refresh failed (HTTP ${res.status})`);
  }
  return {
    accessToken: data.TOKEN,
    refreshToken: data.REFRESH_TOKEN,
    accessExpiresAt: (data.DATA?.accessExpireAt || 0) * 1000,
    refreshExpiresAt: (data.DATA?.refreshExpireAt || 0) * 1000,
  };
}

async function ensureAuth() {
  const entry = await readAuthStore();

  if (entry?.accessToken && entry.accessExpiresAt > Date.now() + 5 * 60 * 1000) {
    return entry.accessToken;
  }

  if (entry?.refreshToken && entry.refreshExpiresAt > Date.now()) {
    try {
      const tokens = await refreshTokens(entry.refreshToken);
      await writeAuthStore(tokens);
      return tokens.accessToken;
    } catch {
      // fall through
    }
  }

  throw new Error(
    "Not authenticated. Use kickpages_authenticate to sign in."
  );
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function apiCall(endpoint, body, token, timeoutMs = 120_000) {
  const headers = { ...BROWSER_HEADERS };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (res.status === 401 || data.FLAG === 2) throw new Error("SESSION_EXPIRED");
  return data;
}

async function authCall(endpoint, body, timeoutMs = 120_000) {
  let token = await ensureAuth();
  try {
    return await apiCall(endpoint, body, token, timeoutMs);
  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      await writeAuthStore({});
      token = await ensureAuth();
      return await apiCall(endpoint, body, token, timeoutMs);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toolOk(data) {
  return { content: [{ type: "text", text: JSON.stringify({ success: true, ...data }) }] };
}

function toolErr(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// MCP Server & Tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "kickpages", version: "1.0.0" });

// --- kickpages_authenticate ---
server.tool(
  "kickpages_authenticate",
  "Sign in to KickPages. Only needed once or when tokens expire.",
  {
    email: z.string().describe("KickPages email"),
    password: z.string().describe("KickPages password"),
  },
  async ({ email, password }) => {
    try {
      const tokens = await signin(email, password);
      await writeAuthStore(tokens);
      return toolOk({ message: `Authenticated as ${email}` });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_create_plan ---
// Saves the full plan to a temp file so init_project doesn't need the massive JSON param
server.tool(
  "kickpages_create_plan",
  "Create a funnel plan from a prompt. Saves plan internally for init_project.",
  {
    prompt: z.string().describe("Description of the funnel"),
  },
  async ({ prompt }) => {
    try {
      const data = await authCall("funnelai/create", { prompt });
      if (data.FLAG !== 1) return toolErr(data.MSG || "Failed to create plan");

      // Save full plan to temp file for init_project to read
      await writeFile(PLAN_PATH, JSON.stringify(data.DATA.plan), "utf-8");

      return toolOk({
        funnelName: data.DATA.plan.funnelName,
        totalPages: data.DATA.totalPages,
        offers: data.DATA.plan.offers,
        pages: data.DATA.plan.pages.map((p) => ({
          pageName: p.pageName,
          role: p.role,
          dependsOn: p.dependsOn,
        })),
      });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_init_project ---
// Reads plan from temp file - no massive JSON in tool parameters
server.tool(
  "kickpages_init_project",
  "Initialize a project from the saved plan. Call create_plan first.",
  {
    prompt: z.string().describe("The original user prompt"),
    projectName: z.string().describe("Project name"),
  },
  async ({ prompt, projectName }) => {
    try {
      let plan;
      try {
        plan = JSON.parse(await readFile(PLAN_PATH, "utf-8"));
      } catch {
        return toolErr("No saved plan found. Call kickpages_create_plan first.");
      }

      const data = await authCall("funnelai/init", { plan, prompt, projectName });
      if (data.FLAG !== 1) return toolErr(data.MSG || "Failed to initialize project");

      return toolOk({
        jobId: data.DATA.jobId,
        projectId: data.DATA.projectId,
        projectUrl: data.DATA.projectUrl,
        totalPages: data.DATA.totalPages,
        funnelName: data.DATA.funnelName,
      });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_generate_and_wait ---
// Fires process, polls until done, returns final result. ONE tool call instead of many.
server.tool(
  "kickpages_generate_and_wait",
  "Generate all pages and wait for completion. Fires process, polls internally, returns final results with URLs.",
  {
    jobId: z.string().describe("Job ID from init_project"),
    debug: z.number().default(0).describe("Debug mode (0 or 1)"),
  },
  async ({ jobId, debug }) => {
    try {
      const token = await ensureAuth();

      // Fire process (don't await)
      fetch(`${BASE_URL}funnelai/process`, {
        method: "POST",
        headers: { ...BROWSER_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId, debug }),
        signal: AbortSignal.timeout(600_000),
      }).catch((err) => {
        process.stderr.write(`process error: ${err.message}\n`);
      });

      // Poll until terminal status
      const MAX_POLLS = 75;
      let lastStatus = null;

      for (let i = 0; i < MAX_POLLS; i++) {
        await sleep(8000);

        try {
          const data = await authCall("funnelai/status", { jobId, debug });
          if (data.FLAG !== 1) continue;

          lastStatus = data.DATA;

          if (lastStatus.status === "completed" || lastStatus.status === "failed") {
            break;
          }
        } catch (err) {
          // Network blip - keep polling
          process.stderr.write(`poll error: ${err.message}\n`);
        }
      }

      if (!lastStatus) {
        return toolErr("Polling timed out with no status response.");
      }

      if (lastStatus.status === "completed") {
        return toolOk({
          status: "completed",
          totalPages: lastStatus.totalPages,
          completedPages: lastStatus.completedPages,
          projectUrl: lastStatus.projectUrl,
          pages: lastStatus.pages.map((p) => ({
            pageName: p.pageName,
            role: p.role,
            status: p.status,
            editorUrl: p.editorUrl || null,
            previewUrl: p.previewUrl || null,
            error: p.error || null,
          })),
        });
      }

      // Failed or timeout
      const failedPages = (lastStatus.pages || []).filter((p) => p.status === "failed");
      const completedPages = (lastStatus.pages || []).filter((p) => p.status === "completed");

      return toolOk({
        status: lastStatus.status || "timeout",
        totalPages: lastStatus.totalPages,
        completedPages: lastStatus.completedPages,
        projectUrl: lastStatus.projectUrl,
        pages: lastStatus.pages.map((p) => ({
          pageName: p.pageName,
          role: p.role,
          status: p.status,
          editorUrl: p.editorUrl || null,
          previewUrl: p.previewUrl || null,
          error: p.error || null,
        })),
        failedCount: failedPages.length,
        completedCount: completedPages.length,
      });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_build_funnel ---
// The all-in-one tool: create plan + init + generate + wait. ONE call does everything.
server.tool(
  "kickpages_build_funnel",
  "Build a complete funnel from a prompt or saved offer. Does everything: plans, creates project, generates all pages, waits for completion. Returns final results with URLs. Pass either prompt OR offerId, not both.",
  {
    prompt: z.string().optional().describe("Description of the funnel to build"),
    offerId: z.number().optional().describe("ID of a saved offer to use instead of a prompt"),
    debug: z.number().default(0).describe("Debug mode (0 or 1)"),
  },
  async ({ prompt, offerId, debug }) => {
    try {
      // --- Phase 0: Resolve prompt from offer if needed ---
      let resolvedPrompt = prompt;
      if (offerId && !prompt) {
        const offerData = await authCall("offers/get-offer", { id: offerId });
        if (offerData.FLAG !== 1) return toolErr(offerData.MSG || "Failed to load offer");
        resolvedPrompt = offerData.DATA?.markdown_content;
        if (!resolvedPrompt) return toolErr("Offer has no content.");
      }
      if (!resolvedPrompt) return toolErr("Provide either a prompt or an offerId.");

      // --- Phase 1: Create plan ---
      const planData = await authCall("funnelai/create", { prompt: resolvedPrompt });
      if (planData.FLAG !== 1) return toolErr(planData.MSG || "Failed to create plan");

      const plan = planData.DATA.plan;
      const funnelName = plan.funnelName;
      const totalPages = planData.DATA.totalPages;
      const offers = plan.offers;

      // --- Phase 2: Init project ---
      const initData = await authCall("funnelai/init", {
        plan,
        prompt: resolvedPrompt,
        projectName: funnelName,
      });
      if (initData.FLAG !== 1) return toolErr(initData.MSG || "Failed to initialize project");

      const jobId = initData.DATA.jobId;
      const projectUrl = initData.DATA.projectUrl;

      // --- Phase 3: Fire generation ---
      const token = await ensureAuth();
      fetch(`${BASE_URL}funnelai/process`, {
        method: "POST",
        headers: { ...BROWSER_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId, debug }),
        signal: AbortSignal.timeout(600_000),
      }).catch((err) => {
        process.stderr.write(`process error: ${err.message}\n`);
      });

      // --- Phase 4: Poll until done ---
      const MAX_POLLS = 75;
      let lastStatus = null;

      for (let i = 0; i < MAX_POLLS; i++) {
        await sleep(8000);
        try {
          const data = await authCall("funnelai/status", { jobId, debug });
          if (data.FLAG !== 1) continue;
          lastStatus = data.DATA;
          if (lastStatus.status === "completed" || lastStatus.status === "failed") break;
        } catch (err) {
          process.stderr.write(`poll error: ${err.message}\n`);
        }
      }

      if (!lastStatus) {
        return toolErr("Generation timed out. Job ID: " + jobId);
      }

      return toolOk({
        funnelName,
        totalPages,
        offers,
        status: lastStatus.status,
        completedPages: lastStatus.completedPages,
        projectUrl,
        jobId,
        pages: (lastStatus.pages || []).map((p) => ({
          pageName: p.pageName,
          role: p.role,
          status: p.status,
          editorUrl: p.editorUrl || null,
          previewUrl: p.previewUrl || null,
          error: p.error || null,
        })),
      });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_check_status (utility - for manual polling) ---
server.tool(
  "kickpages_check_status",
  "Check status of a generation job (single poll). Use generate_and_wait for automatic polling.",
  {
    jobId: z.string().describe("Job ID"),
    debug: z.number().default(0),
  },
  async ({ jobId, debug }) => {
    try {
      const data = await authCall("funnelai/status", { jobId, debug });
      if (data.FLAG !== 1) return toolErr(data.MSG || "Failed to check status");
      return toolOk({
        status: data.DATA.status,
        completedPages: data.DATA.completedPages,
        totalPages: data.DATA.totalPages,
        pages: data.DATA.pages,
      });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_cancel_job ---
server.tool(
  "kickpages_cancel_job",
  "Cancel a running generation job.",
  { jobId: z.string() },
  async ({ jobId }) => {
    try {
      const data = await authCall("funnelai/cancel-job", { jobId });
      if (data.FLAG !== 1) return toolErr(data.MSG || "Failed to cancel");
      return toolOk({ message: "Job cancelled", jobId });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_regenerate_page ---
server.tool(
  "kickpages_regenerate_page",
  "Regenerate a failed page.",
  {
    jobId: z.string(),
    pageIndex: z.number().describe("0-based page index"),
  },
  async ({ jobId, pageIndex }) => {
    try {
      const data = await authCall("funnelai/regenerate-page", { jobId, pageIndex });
      if (data.FLAG !== 1) return toolErr(data.MSG || "Failed to regenerate");
      return toolOk({ pageResult: data.DATA?.pageResult || data.DATA });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_list_offers ---
server.tool(
  "kickpages_list_offers",
  "List saved offers.",
  {},
  async () => {
    try {
      const data = await authCall("offers/get-offers", {
        page: 1, per_page: 20, sort_column: "created_at", sort_direction: "desc",
      });
      if (data.FLAG !== 1) return toolErr(data.MSG || "Failed to list offers");
      return toolOk({ offers: data.DATA });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// --- kickpages_get_offer ---
server.tool(
  "kickpages_get_offer",
  "Get offer details by ID.",
  {
    offerId: z.number().describe("Offer ID"),
  },
  async ({ offerId }) => {
    try {
      const data = await authCall("offers/get-offer", { id: offerId });
      if (data.FLAG !== 1) return toolErr(data.MSG || "Failed to get offer");
      return toolOk({ offer: data.DATA });
    } catch (err) {
      return toolErr(err.message);
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
