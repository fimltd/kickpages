---
name: funnelai
description: Use when the user wants to build a funnel, create landing pages, generate a sales funnel, or describes a product/offer and wants pages built automatically. Triggers on funnel creation requests, page generation, or when the user says "build me a funnel" or "create a kickpages funnel".
---

# FunnelAI - Build Funnels from a Prompt

## Invocation

This skill works two ways — both are fine:
- **Naturally:** "create a KickPages sales funnel with 3 pages for a $97 course" — the skill auto-triggers from the request.
- **Explicitly:** `/kickpages:funnelai [--review] [--debug] [--offer] <prompt>`

## Instructions

Execute the FunnelAI skill. Do NOT ask questions about the funnel. Do NOT use Bash for API calls. Use ONLY kickpages MCP tools.

**CRITICAL: Terminal UI.** Follow the output templates EXACTLY. Copy the unicode characters character-for-character. The output must look polished and branded. Do NOT add commentary between tool calls.

### Step 1: Parse Flags and Prompt

Parse the request for these flags:
- `--review` -> `REVIEW_MODE` = true
- `--debug` -> `DEBUG` = 1 (otherwise 0)
- `--offer` -> `OFFER_MODE` = true

Everything else = `PROMPT` (the funnel description).

If `PROMPT` is empty and no `--offer`, ask the user for a description.

### Step 2: Load Saved Offer (only if --offer)

Skip if `OFFER_MODE` is false.

1. Call `kickpages_list_offers`
2. Show numbered list, ask user to pick
3. Store the selected offer's numeric ID as `OFFER_ID`
4. Immediately proceed to Step 3. Do NOT narrate, explain, or add filler. Just go.

When `OFFER_ID` is set, pass `offerId` instead of `prompt` to `kickpages_build_funnel`. The server loads the offer content internally.

### Step 3: Build the Funnel (standard flow without --review)

If `REVIEW_MODE` is false (the default), use the single all-in-one tool.

Output this header:

```
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 F U N N E L A I
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄

 Building your funnel. This can take a few
 minutes depending on the number of pages.
```

Then call `kickpages_build_funnel` with either:
- `prompt` + `debug` (normal flow)
- `offerId` + `debug` (when --offer is used, pass OFFER_ID here instead of prompt)

This ONE call does everything: loads the offer if needed, creates the plan, initializes the project, generates all pages, and waits for completion. Do NOT call create_plan, init_project, or generate_and_wait separately.

If the response has `success: false` and error contains "Not authenticated": call `kickpages_authenticate` with the user's credentials, then retry `kickpages_build_funnel`.

Skip to Step 5 (Show Results) with the response.

### Step 4: Build with Review (only if --review)

If `REVIEW_MODE` is true, use the multi-step flow so the user can review the plan before generating.

Output the header from Step 3.

Call `kickpages_create_plan` with `prompt`.

If failed, show error and stop.

Show the plan:

```
 Plan    "{funnelName}"
 Pages   {totalPages}
 Offers  {offer count}

 ┌──────────────────────────────────────┬──────────┐
 │ Offer                                │ Price    │
 ├──────────────────────────────────────┼──────────┤
 │ {offer label}                        │ ${price} │
 └──────────────────────────────────────┴──────────┘

 Pages:
   1. {pageName} ({role})
   2. {pageName} ({role}) -> needs: {deps}
   ...

 Generate this funnel? (Y/n)
```

If no, stop.

If yes, output:

```
 Building {totalPages} pages. This can take
 a few minutes depending on the number of pages.
```

Call `kickpages_init_project` with `prompt`, `projectName`.
Then call `kickpages_generate_and_wait` with `jobId`, `debug`.

### Step 5: Show Results

Parse the response from either Step 3 or Step 4.

**If all pages completed:**

```
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 DONE  {completedPages}/{totalPages} pages
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄

 **{funnelName}**
 {projectUrl}

 ─────────────────────────────────────────────

 **1. {pageName}**
    {role}
    Edit    {editorUrl}
    Preview {previewUrl}

 **2. {pageName}**
    {role}
    Edit    {editorUrl}
    Preview {previewUrl}

 ...
```

Also show offers if present:

```
 Offers:
   {label} .... ${price}
```

**If some pages failed:**

Show completed pages as above, then:

```
 ─────────────────────────────────────────────
 FAILED:
   {pageName}: {error}

 Retry? (Y/n)
```

If yes, call `kickpages_regenerate_page` for each failed page.

**If all failed:**

```
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 FAILED
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄

 {error message}

 Try rephrasing your prompt and running the funnel again.
```

### Done

Skill complete. Do not ask follow-up questions.
