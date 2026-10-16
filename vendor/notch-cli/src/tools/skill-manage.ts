/**
 * Notch CLI — `skill_manage` tool.
 *
 * Lets a running agent create, edit, patch, delete, toggle, or list SKILL.md
 * entries mid-task. The agent decides — during a run — that a procedure is
 * worth remembering, and writes a skill via this tool. Future sessions
 * inject enabled skills into the conversation so the agent benefits from
 * its own accumulated know-how.
 *
 * Matches NousResearch/hermes-agent's `tools/skill_manager_tool.py` surface
 * but persists to Supabase (via the web app's REST endpoint) instead of the
 * local filesystem. This means:
 *   - Skills survive sandbox teardown and cross-session workspace moves.
 *   - The Agent Builder web UI can render + edit them.
 *   - Workspace marketplaces can import/export them.
 *
 * Server side: [POST /api/agents/:id/skills/manage]
 * (app/routes/api.agents.$id.skills.manage.ts). Scanner runs on the server,
 * so a malicious agent can't bypass the skills-guard by crafting a payload.
 *
 * Auth: reuses the same browser-obtained token as `notch login`. Agent id
 * comes from either `NOTCH_AGENT_ID` (set by the task-runner when a task is
 * bound to an agent) or the `agent_id` parameter.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { z } from 'zod';
import { loadCredentials } from '../auth.js';
import type { NotchTool, ToolContext, ToolResult } from './types.js';

const API_BASE_ENV = 'NOTCH_API_URL';
const DEFAULT_API_BASE = 'https://freesyntax.dev';
const AGENT_ID_ENV = 'NOTCH_AGENT_ID';

/** Parameter schema. Uses a discriminated union on `action` to keep the
 * LLM-facing docs clear about which fields apply to which action. */
const ParamsSchema = z.object({
  action: z.enum(['create', 'edit', 'patch', 'delete', 'toggle', 'list']),
  /**
   * Target agent id. If omitted, falls back to the `NOTCH_AGENT_ID` env var.
   * In Notch Cloud the task-runner sets this env var when the task was
   * created from an agent. For standalone CLI use, pass it explicitly.
   */
  agent_id: z.string().uuid().optional(),
  /** Required for action=create | edit (optional for edit, keeps existing). */
  name: z.string().min(1).max(40).optional(),
  label: z.string().min(1).max(80).optional(),
  category: z.string().max(40).optional(),
  /** Body of the SKILL.md. Required for create/edit; ignored otherwise. */
  content: z.string().min(1).max(16 * 1024).optional(),
  /** For patch: appended to the existing body with a `---` separator. */
  appendContent: z.string().min(1).max(16 * 1024).optional(),
  /** For edit/create/toggle. */
  enabled: z.boolean().optional(),
  /** For edit/patch/delete/toggle: which existing skill to operate on. */
  skill_id: z.string().uuid().optional(),
});

const DESCRIPTION = `Manage durable agent skills; writes are scanned for prompt overrides, secrets, and exfiltration. Actions: create requires name,label,content (category optional); edit replaces content using skill_id,content; patch appends appendContent using skill_id; delete requires skill_id; toggle requires skill_id,enabled; list enumerates skills. Write terse SKILL.md triggers and procedures.`;

/**
 * Build the `skill_manage` tool using the AI-SDK `tool()` helper. Shares
 * shape with the rest of BUILTIN_TOOLS (see tools/index.ts).
 */
export const skillManageTool: NotchTool<typeof ParamsSchema> = {
  name: 'skill_manage',
  description: DESCRIPTION,
  parameters: ParamsSchema,
  execute: async (params, ctx: ToolContext): Promise<ToolResult> => {
    const creds = await loadCredentials();
    if (!creds) {
      return {
        isError: true,
        content: 'Not authenticated. Run `notch login` first so skills can be persisted to your workspace.',
      };
    }

    const agentId = params.agent_id ?? process.env[AGENT_ID_ENV];
    if (!agentId) {
      return {
        isError: true,
        content: `No agent id available. Pass agent_id explicitly, or ensure the task-runner set ${AGENT_ID_ENV}. For standalone CLI use there is no agent to attach skills to — use a ~/.notch/skills/ local file instead.`,
      };
    }

    const base = process.env[API_BASE_ENV] ?? DEFAULT_API_BASE;
    const url = `${base.replace(/\/+$/, '')}/api/agents/${agentId}/skills/manage`;

    const body = buildRequestBody(params);
    if (!body) {
      return {
        isError: true,
        content: `Action "${params.action}" is missing required fields. Check the parameter docs.`,
      };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'notch-cli/skill_manage',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text); } catch { /* non-JSON */ }

      if (!res.ok) {
        // 422 = scanner rejection (findings list is useful to the agent).
        // 401/403/404 = auth or ownership problem.
        const summary = (parsed['summary'] as string | undefined) ?? String(parsed['error'] ?? res.statusText);
        ctx.log?.(`[skill_manage] ${params.action} → HTTP ${res.status}: ${summary}`);
        const findings = Array.isArray(parsed['findings']) ? parsed['findings'] : [];
        return {
          isError: true,
          content: JSON.stringify({
            ok: false,
            status: res.status,
            action: params.action,
            summary,
            findings,
          }, null, 2),
        };
      }

      ctx.log?.(`[skill_manage] ${params.action} ok`);
      return {
        content: typeof text === 'string' && text.length > 0 ? text : JSON.stringify({ ok: true }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: `Network error calling skill_manage: ${message}`,
      };
    }
  },
};

/**
 * Map the flat parameter shape to the discriminated-union body the server
 * endpoint expects. Returns null when required fields for the chosen action
 * are missing — the tool surfaces this as an error without hitting the
 * network.
 */
function buildRequestBody(p: z.infer<typeof ParamsSchema>): Record<string, unknown> | null {
  switch (p.action) {
    case 'create': {
      if (!p.name || !p.label || !p.content) return null;
      return {
        action: 'create',
        name: p.name,
        label: p.label,
        category: p.category ?? null,
        content: p.content,
        enabled: p.enabled ?? true,
      };
    }
    case 'edit': {
      if (!p.skill_id || !p.content) return null;
      return {
        action: 'edit',
        skillId: p.skill_id,
        name: p.name,
        label: p.label,
        category: p.category ?? null,
        content: p.content,
        enabled: p.enabled,
      };
    }
    case 'patch': {
      if (!p.skill_id || !p.appendContent) return null;
      return {
        action: 'patch',
        skillId: p.skill_id,
        appendContent: p.appendContent,
      };
    }
    case 'delete': {
      if (!p.skill_id) return null;
      return { action: 'delete', skillId: p.skill_id };
    }
    case 'toggle': {
      if (!p.skill_id || typeof p.enabled !== 'boolean') return null;
      return { action: 'toggle', skillId: p.skill_id, enabled: p.enabled };
    }
    case 'list':
      return { action: 'list' };
  }
}
